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

/**
 * Shared voice entry shape used by all TTS backends.
 */
export interface VoiceEntry {
  id: string;
  label: string;
  language: string;
  gender: string;
  engine: string;
  sampleRate: number | null;
}

export interface TTSSynthesizeInput {
  text: string;
  voice?: string;
  speed?: number;
}

export interface TTSSynthesizeResult {
  audio: string;
  mimeType: string;
  durationMs: number;
  voice: string;
  engine: string;
}

/**
 * TTS runtime interface — extends CapabilityRuntime with synthesis and voice
 * catalogue. All external network calls inside synthesize() and getVoices()
 * must log a privacy event (Standard 13).
 */
export interface TTSRuntime extends CapabilityRuntime {
  readonly capabilityType: "tts";

  /** Static voice catalogue for this backend (shown when no API key available). */
  readonly voices: ReadonlyArray<VoiceEntry>;

  /**
   * Synthesize text to audio.
   * @param ctx    - tenant context for privacy event logging.
   * @param input  - text, optional voice id, optional speed (0.5–2.0).
   * @param apiKey - required for cloud backends; null/undefined for local.
   * @returns      - base64-encoded audio + metadata.
   */
  synthesize(
    ctx: TenantContext,
    input: TTSSynthesizeInput,
    apiKey?: string | null,
  ): Promise<TTSSynthesizeResult>;

  /**
   * Optionally fetch live account voices (e.g. ElevenLabs cloned / premium
   * voices). Returns the static catalogue when not overridden.
   */
  getVoices?(
    ctx: TenantContext,
    apiKey?: string | null,
  ): Promise<ReadonlyArray<VoiceEntry>>;
}

export interface EmbeddingsRuntime extends CapabilityRuntime {
  readonly capabilityType: "embeddings";
}

export interface CodeSandboxRuntime extends CapabilityRuntime {
  readonly capabilityType: "code-sandbox";
}

export interface CapabilityDescriptor {
  id: string;
  displayName: string;
  capabilityType: CapabilityType;
  residency: CapabilityResidency;
  requiresApiKey: boolean;
  hasCredential: boolean;
  health: CapabilityHealth;
}

export interface ActiveCapabilityInfo {
  capabilityType: CapabilityType;
  activeBackendId: string | null;
  detectedBackendIds: string[];
  backends: CapabilityDescriptor[];
}
