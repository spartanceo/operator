/**
 * OpenAI cloud adapter.
 *
 * residency = "cloud-required". The registry MUST gate every chat call on
 * a per-session cloud confirmation; the adapter trusts its inputs and
 * raises a recognisable error code when no API key is bound.
 *
 * Privacy log every fetch() within ±10 lines (tier-review Check #8).
 */
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "../../privacy.service";
import {
  RuntimeUpstreamError,
  type ModelRuntime,
  type RuntimeChatRequest,
  type RuntimeChatResult,
  type RuntimeHealth,
  type RuntimeModel,
} from "../types";

const DEFAULT_TIMEOUT_MS = 60_000;
const HOST = "https://api.openai.com";

export class CloudCredentialMissingError extends Error {
  readonly code = "CLOUD_CREDENTIAL_MISSING";
  readonly runtimeId: string;
  constructor(runtimeId: string) {
    super(`Cloud runtime "${runtimeId}" has no API key configured for this tenant`);
    this.runtimeId = runtimeId;
  }
}

interface OpenAiModelsResp {
  data?: Array<{ id?: string; created?: number; owned_by?: string }>;
}

interface OpenAiChatResp {
  model?: string;
  choices?: Array<{ message?: { role?: string; content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function openaiFetch(
  ctx: TenantContext,
  url: string,
  init: RequestInit,
  privacyTarget: string,
): Promise<Response | null> {
  // Privacy log adjacent to the network call — Check #8 enforces ±10 lines.
  await logPrivacyEvent(ctx, {
    eventType: "network.openai",
    actor: ctx.userId ?? ctx.tenantId,
    target: privacyTarget,
    severity: "medium",
    detail: init.method ?? "GET",
  });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch {
    return null;
  }
}

export const openaiAdapter: ModelRuntime = {
  id: "openai",
  displayName: "OpenAI (cloud)",
  residency: "cloud-required",
  requiresApiKey: true,
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: true,
  },

  async detect() {
    // Cloud runtimes are always "available" — health() decides whether
    // they're usable based on credentials.
    return true;
  },

  async health(ctx, apiKey): Promise<RuntimeHealth> {
    const detectedAt = new Date().toISOString();
    if (!apiKey) return { status: "needs-credentials", detail: "No API key configured", detectedAt };
    const res = await openaiFetch(
      ctx,
      `${HOST}/v1/models`,
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      "openai:health",
    );
    if (!res) return { status: "unreachable", detail: "openai.com unreachable", detectedAt };
    if (res.status === 401) return { status: "needs-credentials", detail: "API key rejected", detectedAt };
    if (!res.ok) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
    return { status: "healthy", detail: null, detectedAt };
  },

  async listModels(ctx, apiKey): Promise<RuntimeModel[]> {
    if (!apiKey) throw new CloudCredentialMissingError("openai");
    const res = await openaiFetch(
      ctx,
      `${HOST}/v1/models`,
      { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
      "openai:/v1/models",
    );
    if (!res || !res.ok) return [];
    const json = (await res.json()) as OpenAiModelsResp;
    return (json.data ?? []).map((m) => ({
      name: m.id ?? "unknown",
      status: "ready" as const,
      sizeBytes: null,
      family: m.owned_by ?? null,
      modifiedAt: typeof m.created === "number" ? new Date(m.created * 1000).toISOString() : null,
    }));
  },

  async chat(ctx, req: RuntimeChatRequest, apiKey): Promise<RuntimeChatResult> {
    if (!apiKey) throw new CloudCredentialMissingError("openai");
    const body = {
      model: req.model || "gpt-4o-mini",
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      stream: false,
    };
    const res = await openaiFetch(
      ctx,
      `${HOST}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      `openai:/v1/chat/completions:${body.model}`,
    );
    if (!res) {
      // Network failure — surface as a normalized upstream error so the
      // runtime service can throw RUNTIME_UNAVAILABLE and the agent
      // orchestrator can pause-and-notify instead of treating a stub
      // assistant message as a real response.
      throw new RuntimeUpstreamError("openai", "api.openai.com unreachable", null);
    }
    if (!res.ok) {
      let body401Detail = `HTTP ${res.status}`;
      try {
        const txt = await res.text();
        if (txt) body401Detail = `HTTP ${res.status}: ${txt.slice(0, 240)}`;
      } catch {
        /* ignore body read failure */
      }
      throw new RuntimeUpstreamError("openai", body401Detail, res.status);
    }
    const json = (await res.json()) as OpenAiChatResp;
    const choice = json.choices?.[0]?.message;
    return {
      model: json.model ?? body.model,
      message: {
        role: (choice?.role as "system" | "user" | "assistant" | "tool") ?? "assistant",
        content: choice?.content ?? "",
      },
      tokensIn: json.usage?.prompt_tokens ?? null,
      tokensOut: json.usage?.completion_tokens ?? null,
    };
  },
};
