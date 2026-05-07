/**
 * Capability runtime abstraction — mirrors the shape of `ModelRuntime` for
 * every AI capability that is NOT text-generation:
 *
 *   - ImageGen     — diffusion / image-generation backends (ComfyUI, DALL-E, etc.)
 *   - WebSearch    — web-search backends (SearXNG, Brave Search, etc.)
 *   - TTS          — text-to-speech / voice-synthesis backends (Piper, ElevenLabs, etc.)
 *   - Embeddings   — vector-embedding backends (Ollama, OpenAI ada-002, etc.)
 *   - CodeSandbox  — sandboxed code-execution backends (local Docker, E2B, etc.)
 *
 * Residency taxonomy is identical to `ModelRuntime`:
 *   - "local"          — runs entirely on the user's machine; no egress.
 *   - "cloud-assist"   — cloud, but only on explicit calls with a user-owned key.
 *   - "cloud-required" — always cloud; no local fallback available.
 *
 * Each concrete capability type extends `CapabilityRuntime<TInput, TOutput>`
 * with capability-specific `run()` signatures. Backends that have not yet been
 * implemented leave `detect()` returning `false` and `health()` returning
 * `{ status: "unknown" }`.
 */
import type { TenantContext } from "@workspace/types";

export type CapabilityResidency = "local" | "cloud-assist" | "cloud-required";
export type CapabilityHealthStatus = "healthy" | "unreachable" | "needs-credentials" | "unknown";

export type CapabilityType = "image-gen" | "web-search" | "tts" | "embeddings" | "code-sandbox";

export interface CapabilityHealth {
  status: CapabilityHealthStatus;
  detail: string | null;
  detectedAt: string;
}

/**
 * Base runtime contract. Every capability backend must implement this so the
 * registry, auto-detector, and switcher UI can treat all capability types
 * uniformly.
 */
export interface CapabilityRuntime {
  readonly id: string;
  readonly displayName: string;
  readonly capabilityType: CapabilityType;
  readonly residency: CapabilityResidency;
  readonly requiresApiKey: boolean;

  detect(ctx: TenantContext): Promise<boolean>;
  health(ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth>;
}

export interface ImageGenRuntime extends CapabilityRuntime {
  readonly capabilityType: "image-gen";
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchRuntime extends CapabilityRuntime {
  readonly capabilityType: "web-search";
  search(
    ctx: TenantContext,
    query: string,
    numResults: number,
    apiKey?: string | null,
  ): Promise<WebSearchResult[]>;
}

export interface TTSRuntime extends CapabilityRuntime {
  readonly capabilityType: "tts";
}

export interface EmbeddingsRuntime extends CapabilityRuntime {
  readonly capabilityType: "embeddings";
}

export interface CodeSandboxRuntime extends CapabilityRuntime {
  readonly capabilityType: "code-sandbox";
}

/**
 * Descriptor used by routes and UI — a serialisable snapshot of a backend's
 * static properties plus whether a credential is currently stored.
 */
export interface CapabilityDescriptor {
  id: string;
  displayName: string;
  capabilityType: CapabilityType;
  residency: CapabilityResidency;
  requiresApiKey: boolean;
  hasCredential: boolean;
  health: CapabilityHealth;
}

/**
 * Active selection for one capability type — returned by the service layer and
 * consumed by the switcher UI.
 */
export interface ActiveCapabilityInfo {
  capabilityType: CapabilityType;
  activeBackendId: string | null;
  detectedBackendIds: string[];
  backends: CapabilityDescriptor[];
}
