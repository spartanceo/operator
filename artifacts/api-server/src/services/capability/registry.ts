/**
 * Capability runtime registry — the single source of truth for all non-LLM
 * AI capability backends.
 *
 * Each capability type has at least one "local" slot and at least one "cloud"
 * slot. Backends that have not yet been implemented return detect()=false and
 * health()={ status:"unknown" } — they are listed in the registry so the
 * switcher UI can display them as "coming soon" without code changes later.
 *
 * TTS backends are fully implemented as real runtimes:
 *   - PiperTTSRuntime    — local, calls piper-http on port 5000
 *   - ElevenLabsTTSRuntime — cloud, requires API key
 *   - OpenAITTSRuntime   — cloud, requires API key
 *
 * Known default ports probed during auto-detection:
 *   ComfyUI    — 8188  (image-gen)
 *   SearXNG    — 8080  (web-search)
 *   Piper TTS  — 5000  (tts)
 *   Qdrant     — 6333  (embeddings)
 *   Ollama     — 11434 (embeddings — reuses the LLM adapter's embed endpoint)
 *   Sandbox    — 2375  (code-sandbox — Docker socket proxy)
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../privacy.service";
import type {
  CapabilityRuntime,
  CapabilityType,
  CapabilityHealth,
} from "./types";
import { searxngRuntime } from "./web-search/searxng";
import { braveRuntime } from "./web-search/brave";
import { serperRuntime } from "./web-search/serper";
import { bingRuntime } from "./web-search/bing";
import { PiperTTSRuntime } from "./tts/piper";
import { ElevenLabsTTSRuntime } from "./tts/elevenlabs";
import { OpenAITTSRuntime } from "./tts/openai-tts";

function unknownHealth(): CapabilityHealth {
  return { status: "unknown", detail: "Backend not yet implemented", detectedAt: new Date().toISOString() };
}

/**
 * Quick TCP-level probe — connects to localhost only; no user data is sent.
 * logPrivacyEvent is called by the caller (detect/health) so the audit log
 * records that a local service probe was attempted.
 */
async function probePort(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    // logPrivacyEvent: local-only probe; no data leaves this host — see callers
    const res = await fetch(`http://${host}:${port}/`, { signal: controller.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}

async function probe(ctx: TenantContext, host: string, port: number): Promise<boolean> {
  const ok = await probePort(host, port);
  await logPrivacyEvent(ctx, {
    eventType: "runtime.detect",
    actor: ctx.userId ?? ctx.tenantId,
    target: `${host}:${port}`,
    severity: "info",
    detail: `capability local probe → ${ok ? "reachable" : "unreachable"}`,
  });
  return ok;
}

function stubBackend(
  id: string,
  displayName: string,
  capabilityType: CapabilityType,
  residency: "local" | "cloud-assist" | "cloud-required",
  requiresApiKey: boolean,
  probePort?: number,
): CapabilityRuntime {
  return {
    id,
    displayName,
    capabilityType,
    residency,
    requiresApiKey,
    async detect(ctx: TenantContext): Promise<boolean> {
      if (!probePort || residency !== "local") return false;
      return probe(ctx, "localhost", probePort);
    },
    async health(ctx: TenantContext, _apiKey?: string | null): Promise<CapabilityHealth> {
      if (!probePort && residency === "local") return unknownHealth();
      if (residency !== "local") {
        if (requiresApiKey && !_apiKey) {
          return { status: "needs-credentials", detail: "API key required", detectedAt: new Date().toISOString() };
        }
        return unknownHealth();
      }
      const ok = await probe(ctx, "localhost", probePort!);
      return {
        status: ok ? "healthy" : "unreachable",
        detail: ok ? null : `Nothing listening on port ${probePort}`,
        detectedAt: new Date().toISOString(),
      };
    },
  };
}

export const ALL_CAPABILITY_BACKENDS: ReadonlyArray<CapabilityRuntime> = [
  stubBackend("comfyui", "ComfyUI (local)", "image-gen", "local", false, 8188),
  stubBackend("dalle", "DALL-E (OpenAI)", "image-gen", "cloud-required", true),
  stubBackend("stability-ai", "Stability AI", "image-gen", "cloud-required", true),

  searxngRuntime,
  braveRuntime,
  serperRuntime,
  bingRuntime,

  new PiperTTSRuntime(),
  new ElevenLabsTTSRuntime(),
  new OpenAITTSRuntime(),

  stubBackend("ollama-embed", "Ollama Embeddings (local)", "embeddings", "local", false, 11434),
  stubBackend("qdrant-embed", "Qdrant + Ollama (local)", "embeddings", "local", false, 6333),
  stubBackend("openai-embed", "OpenAI Embeddings (ada-002)", "embeddings", "cloud-required", true),

  stubBackend("local-sandbox", "Local Docker Sandbox", "code-sandbox", "local", false, 2375),
  stubBackend("e2b-sandbox", "E2B Cloud Sandbox", "code-sandbox", "cloud-required", true),
  stubBackend("modal-sandbox", "Modal Cloud Sandbox", "code-sandbox", "cloud-required", true),
];

// tier-review: bounded — built once from the static ALL_CAPABILITY_BACKENDS tuple, never mutated
const BY_ID: ReadonlyMap<string, CapabilityRuntime> = new Map(
  ALL_CAPABILITY_BACKENDS.map((b) => [b.id, b] as const),
);

export function listCapabilityBackends(): ReadonlyArray<CapabilityRuntime> {
  return ALL_CAPABILITY_BACKENDS;
}

export function listCapabilityBackendsForType(type: CapabilityType): ReadonlyArray<CapabilityRuntime> {
  return ALL_CAPABILITY_BACKENDS.filter((b) => b.capabilityType === type);
}

export function getCapabilityBackend(id: string): CapabilityRuntime | null {
  return BY_ID.get(id) ?? null;
}

export const ALL_CAPABILITY_TYPES: ReadonlyArray<CapabilityType> = [
  "image-gen",
  "web-search",
  "tts",
  "embeddings",
  "code-sandbox",
];

/**
 * Walk every local backend's detect() in parallel and return the ids of
 * those that responded. Used by the auto-detection endpoint on app start.
 */
export async function detectLocalCapabilityBackends(ctx: TenantContext): Promise<string[]> {
  const locals = ALL_CAPABILITY_BACKENDS.filter((b) => b.residency === "local");
  const results = await Promise.all(
    locals.map((b) => b.detect(ctx).then((ok) => [b.id, ok] as const)),
  );
  return results.filter(([, ok]) => ok).map(([id]) => id);
}
