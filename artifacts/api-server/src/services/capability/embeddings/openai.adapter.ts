/**
 * OpenAI Embeddings adapter — calls the OpenAI `/v1/embeddings` endpoint.
 *
 * Default model: `text-embedding-ada-002` (1536-dim).
 * Requires an OpenAI API key stored via the capability credentials system.
 *
 * Privacy: every outbound `fetch()` is paired with a `logPrivacyEvent` call
 * within ±10 lines (tier-review Check #8).
 */
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "../../privacy.service";
import type { CapabilityHealth, EmbeddingsRuntime } from "../types";

const DEFAULT_MODEL = "text-embedding-ada-002";
const API_BASE = "https://api.openai.com/v1";
const EMBED_TIMEOUT_MS = 30_000;

interface OpenAIEmbedResp {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
}

async function fetchEmbed(
  ctx: TenantContext,
  text: string,
  model: string,
  apiKey: string,
): Promise<number[]> {
  await logPrivacyEvent(ctx, {
    eventType: "network.openai",
    actor: ctx.userId ?? ctx.tenantId,
    target: "openai:/v1/embeddings",
    severity: "medium",
    detail: `model=${model}`,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as OpenAIEmbedResp;
    return json.data?.[0]?.embedding ?? [];
  } catch {
    clearTimeout(timer);
    return [];
  }
}

export const openAIEmbeddingsAdapter: EmbeddingsRuntime = {
  id: "openai-embed",
  displayName: "OpenAI Embeddings (ada-002)",
  capabilityType: "embeddings",
  residency: "cloud-required",
  requiresApiKey: true,
  defaultModel: DEFAULT_MODEL,

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  },

  async health(ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    if (!apiKey) {
      return { status: "needs-credentials", detail: "OpenAI API key required", detectedAt };
    }
    await logPrivacyEvent(ctx, {
      eventType: "runtime.detect",
      actor: ctx.userId ?? ctx.tenantId,
      target: "openai:health",
      severity: "medium",
      detail: "capability health probe",
    });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 401) {
        return { status: "needs-credentials", detail: "Invalid API key", detectedAt };
      }
      if (!res.ok) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
      return { status: "healthy", detail: null, detectedAt };
    } catch {
      return { status: "unreachable", detail: "OpenAI API not reachable", detectedAt };
    }
  },

  async embed(ctx: TenantContext, text: string, apiKey?: string | null): Promise<number[]> {
    if (!apiKey) return [];
    return fetchEmbed(ctx, text, DEFAULT_MODEL, apiKey);
  },
};
