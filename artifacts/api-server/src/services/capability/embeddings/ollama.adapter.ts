/**
 * Ollama Embeddings adapter — calls the Ollama `/api/embed` endpoint to
 * produce float vectors from text.
 *
 * Default model: `nomic-embed-text` (pulled on first use via Ollama).
 * The embedding dimension depends on the model; nomic-embed-text → 768.
 *
 * Privacy: every outbound `fetch()` is paired with a `logPrivacyEvent` call
 * within ±10 lines (tier-review Check #8).
 */
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "../../privacy.service";
import type { CapabilityHealth, EmbeddingsRuntime } from "../types";

const DEFAULT_MODEL = "nomic-embed-text";
const EMBED_TIMEOUT_MS = 30_000;

function ollamaHost(): string {
  return process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
}

interface OllamaEmbedResp {
  embeddings?: number[][];
  embedding?: number[];
}

async function fetchEmbed(
  ctx: TenantContext,
  text: string,
  model: string,
): Promise<number[]> {
  const url = `${ollamaHost()}/api/embed`;
  await logPrivacyEvent(ctx, {
    eventType: "network.ollama",
    actor: ctx.userId ?? ctx.tenantId,
    target: `ollama:/api/embed:${model}`,
    severity: "low",
    detail: "POST",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as OllamaEmbedResp;
    if (Array.isArray(json.embeddings) && json.embeddings.length > 0) {
      return (json.embeddings[0] as number[]) ?? [];
    }
    if (Array.isArray(json.embedding)) return json.embedding;
    return [];
  } catch {
    clearTimeout(timer);
    return [];
  }
}

export const ollamaEmbeddingsAdapter: EmbeddingsRuntime = {
  id: "ollama-embed",
  displayName: "Ollama Embeddings (local)",
  capabilityType: "embeddings",
  residency: "local",
  requiresApiKey: false,
  defaultModel: DEFAULT_MODEL,

  async detect(ctx: TenantContext): Promise<boolean> {
    const url = `${ollamaHost()}/api/tags`;
    await logPrivacyEvent(ctx, {
      eventType: "runtime.detect",
      actor: ctx.userId ?? ctx.tenantId,
      target: "ollama:detect",
      severity: "info",
      detail: "capability local probe",
    });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(timer);
      return res.status < 500;
    } catch {
      return false;
    }
  },

  async health(ctx: TenantContext): Promise<CapabilityHealth> {
    const url = `${ollamaHost()}/api/tags`;
    const detectedAt = new Date().toISOString();
    await logPrivacyEvent(ctx, {
      eventType: "runtime.detect",
      actor: ctx.userId ?? ctx.tenantId,
      target: "ollama:health",
      severity: "info",
      detail: "capability health probe",
    });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
      return { status: "healthy", detail: null, detectedAt };
    } catch {
      return {
        status: "unreachable",
        detail: `Ollama not reachable at ${ollamaHost()}`,
        detectedAt,
      };
    }
  },

  async embed(ctx: TenantContext, text: string): Promise<number[]> {
    return fetchEmbed(ctx, text, DEFAULT_MODEL);
  },
};
