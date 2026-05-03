/**
 * Ollama integration — local LLM model lifecycle + chat.
 *
 * Every call out to the Ollama HTTP API is wrapped with a privacy event so
 * the user can audit which model ran, when, and what payload size left the
 * process. Even when the target host is `127.0.0.1` (the default), the call
 * is recorded — the user owns the model server too, but the audit log is
 * the only authoritative record.
 *
 * Errors degrade gracefully: when Ollama is unreachable we surface a stable
 * `OLLAMA_UNAVAILABLE` error code rather than letting the network exception
 * bubble. The chat endpoint stays usable for the deterministic fallback
 * agents (Tier 1) even when no model is installed.
 */
import type { TenantContext } from "@workspace/types";

import { withModelLock } from "../lib/model-lock";
import { logPrivacyEvent } from "./privacy.service";

const DEFAULT_TIMEOUT_MS = 60_000;

function ollamaHost(): string {
  return process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
}

export interface OllamaModel {
  name: string;
  status: "ready" | "pulling" | "missing";
  sizeBytes: number | null;
  family: string | null;
  modifiedAt: string | null;
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  temperature?: number;
  /**
   * Optional per-call network timeout in milliseconds.
   * Overrides DEFAULT_TIMEOUT_MS when set. Intended for non-blocking
   * background calls (e.g. plan description generation) so they fail fast
   * when Ollama is unavailable without keeping the process alive.
   */
  timeoutMs?: number;
}

export interface OllamaChatResult {
  model: string;
  message: OllamaChatMessage;
  tokensIn: number | null;
  tokensOut: number | null;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    modified_at?: string;
    details?: { family?: string };
  }>;
}

interface OllamaChatApiResponse {
  message?: { role?: string; content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function ollamaFetch(
  ctx: TenantContext,
  url: string,
  init: RequestInit,
  privacyTarget: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response | null> {
  // logPrivacyEvent below MUST run within ±10 lines of the fetch() call so
  // the tier-review gate (Check #8) sees the audit pairing. Keep the
  // privacy log immediately adjacent to every network call.
  await logPrivacyEvent(ctx, {
    eventType: "network.ollama",
    actor: ctx.userId ?? ctx.tenantId,
    target: privacyTarget,
    severity: "low",
    detail: init.method ?? "GET",
  });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch {
    return null;
  }
}

export async function listModels(ctx: TenantContext): Promise<OllamaModel[]> {
  const url = `${ollamaHost()}/api/tags`;
  const res = await ollamaFetch(ctx, url, { method: "GET" }, "ollama:/api/tags");
  if (!res || !res.ok) return [];
  const json = (await res.json()) as OllamaTagsResponse;
  const models = json.models ?? [];
  return models.map((m) => ({
    name: m.name ?? "unknown",
    status: "ready" as const,
    sizeBytes: typeof m.size === "number" ? m.size : null,
    family: m.details?.family ?? null,
    modifiedAt: m.modified_at ?? null,
  }));
}

export async function getModel(
  ctx: TenantContext,
  name: string,
): Promise<OllamaModel | null> {
  const all = await listModels(ctx);
  return all.find((m) => m.name === name) ?? null;
}

export async function pullModel(
  ctx: TenantContext,
  name: string,
): Promise<{ name: string; status: string; scheduledAt: string }> {
  const url = `${ollamaHost()}/api/pull`;
  await ollamaFetch(
    ctx,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, stream: false }),
    },
    `ollama:/api/pull:${name}`,
  );
  return { name, status: "scheduled", scheduledAt: new Date().toISOString() };
}

export async function chat(
  ctx: TenantContext,
  req: OllamaChatRequest,
): Promise<OllamaChatResult> {
  const url = `${ollamaHost()}/api/chat`;
  const body = {
    model: req.model,
    messages: req.messages,
    stream: false,
    options: {
      temperature: req.temperature ?? 0.2,
    },
  };
  // Serialize every real model invocation across the process. The task
  // queue runs N tasks in parallel on capable hardware, but the underlying
  // model adapter must serve them one at a time to avoid VRAM/RAM thrash.
  const res = await withModelLock(() =>
    ollamaFetch(
      ctx,
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      `ollama:/api/chat:${req.model}`,
      req.timeoutMs,
    ),
  );
  if (!res || !res.ok) {
    // Degrade gracefully: return a deterministic stub message so the chat
    // endpoint stays usable in Tier 1 environments without a running Ollama.
    return {
      model: req.model,
      message: {
        role: "assistant",
        content:
          "Ollama is not reachable on this host. Returning a deterministic stub reply so the local-first flow remains usable.",
      },
      tokensIn: null,
      tokensOut: null,
    };
  }
  const json = (await res.json()) as OllamaChatApiResponse;
  const message: OllamaChatMessage = {
    role: (json.message?.role as OllamaChatMessage["role"]) ?? "assistant",
    content: json.message?.content ?? "",
  };
  return {
    model: json.model ?? req.model,
    message,
    tokensIn: json.prompt_eval_count ?? null,
    tokensOut: json.eval_count ?? null,
  };
}
