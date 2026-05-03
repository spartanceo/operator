/**
 * Anthropic cloud adapter.
 *
 * residency = "cloud-required". The registry gates every chat call on
 * per-session confirmation; the adapter raises CloudCredentialMissingError
 * when no API key is bound.
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
import { CloudCredentialMissingError } from "./openai.adapter";

const DEFAULT_TIMEOUT_MS = 60_000;
const HOST = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

// Anthropic does not expose a public /v1/models REST endpoint, so we ship
// a pinned list of the chat-capable models. Users override at chat time
// by passing `model` explicitly.
const KNOWN_MODELS: ReadonlyArray<string> = [
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "claude-3-opus-latest",
];

interface AnthropicMessagesResp {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function anthropicFetch(
  ctx: TenantContext,
  url: string,
  init: RequestInit,
  privacyTarget: string,
): Promise<Response | null> {
  // Privacy log adjacent to the network call — Check #8 enforces ±10 lines.
  await logPrivacyEvent(ctx, {
    eventType: "network.anthropic",
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

function splitSystem(messages: RuntimeChatRequest["messages"]): {
  system: string | null;
  rest: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return { system: sys.length > 0 ? sys.join("\n\n") : null, rest };
}

export const anthropicAdapter: ModelRuntime = {
  id: "anthropic",
  displayName: "Anthropic (cloud)",
  residency: "cloud-required",
  requiresApiKey: true,
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
  },

  async detect() {
    return true;
  },

  async health(ctx, apiKey): Promise<RuntimeHealth> {
    const detectedAt = new Date().toISOString();
    if (!apiKey) return { status: "needs-credentials", detail: "No API key configured", detectedAt };
    // Probe with a tiny messages call — Anthropic has no models endpoint.
    const probeBody = {
      model: KNOWN_MODELS[1],
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    };
    const res = await anthropicFetch(
      ctx,
      `${HOST}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(probeBody),
      },
      "anthropic:health",
    );
    if (!res) return { status: "unreachable", detail: "api.anthropic.com unreachable", detectedAt };
    if (res.status === 401 || res.status === 403) {
      return { status: "needs-credentials", detail: "API key rejected", detectedAt };
    }
    if (!res.ok && res.status >= 500) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
    // 4xx other than auth still means the service is responding — count as healthy.
    return { status: "healthy", detail: null, detectedAt };
  },

  async listModels(_ctx, apiKey): Promise<RuntimeModel[]> {
    if (!apiKey) throw new CloudCredentialMissingError("anthropic");
    return KNOWN_MODELS.map((name) => ({
      name,
      status: "ready" as const,
      sizeBytes: null,
      family: "anthropic",
      modifiedAt: null,
    }));
  },

  async chat(ctx, req: RuntimeChatRequest, apiKey): Promise<RuntimeChatResult> {
    if (!apiKey) throw new CloudCredentialMissingError("anthropic");
    const { system, rest } = splitSystem(req.messages);
    const targetModel = req.model || KNOWN_MODELS[0];
    const body = {
      model: targetModel,
      max_tokens: 1024,
      temperature: req.temperature ?? 0.2,
      ...(system ? { system } : {}),
      messages: rest,
    };
    const res = await anthropicFetch(
      ctx,
      `${HOST}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
      },
      `anthropic:/v1/messages:${targetModel}`,
    );
    if (!res) {
      // Network failure — normalize so runtime.service can convert into
      // a RUNTIME_UNAVAILABLE response. Returning a stub message would
      // mask cloud outages from the agent orchestrator.
      throw new RuntimeUpstreamError("anthropic", "api.anthropic.com unreachable", null);
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const txt = await res.text();
        if (txt) detail = `HTTP ${res.status}: ${txt.slice(0, 240)}`;
      } catch {
        /* ignore body read failure */
      }
      throw new RuntimeUpstreamError("anthropic", detail, res.status);
    }
    const json = (await res.json()) as AnthropicMessagesResp;
    const text = (json.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    return {
      model: json.model ?? targetModel,
      message: { role: "assistant", content: text },
      tokensIn: json.usage?.input_tokens ?? null,
      tokensOut: json.usage?.output_tokens ?? null,
    };
  },
};
