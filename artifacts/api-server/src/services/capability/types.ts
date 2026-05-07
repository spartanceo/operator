/**
 * Capability runtime abstraction — mirrors the shape of `ModelRuntime` for
 * every AI capability that is NOT text-generation:
 *
 *   - ImageGen     — diffusion / image-generation backends (ComfyUI, DALL-E, etc.)
 *   - WebSearch    — web-search backends (SearXNG, Brave Search, etc.)
 *   - TTS          — text-to-speech / voice-synthesis backends (Piper, ElevenLabs, etc.)
 *   - Embeddings   — vector-embedding backends (Ollama nomic-embed-text, OpenAI ada-002)
 *   - VectorStore  — vector-search backends (Qdrant, ChromaDB, Pinecone, Weaviate)
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

export type CapabilityType =
  | "image-gen"
  | "web-search"
  | "tts"
  | "embeddings"
  | "vector-store"
  | "code-sandbox";

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

/**
 * Image generation request — passed to ImageGenRuntime.generate().
 * All size / sampler fields are optional; adapters fall back to sensible
 * defaults when omitted so callers don't need to know adapter-specific
 * limits (e.g. DALL-E snaps to its fixed aspect-ratio set regardless).
 */
export interface ImageGenRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number | null;
  /** ComfyUI only — name of the checkpoint file to use. */
  checkpoint?: string;
}

/**
 * Uniform image generation result. All adapters return base64-encoded PNG
 * so the chat UI can embed the image without an extra download step.
 */
export interface ImageGenResult {
  /** Raw image bytes encoded as base64. */
  imageBase64: string;
  mimeType: "image/png" | "image/webp" | "image/jpeg";
  width: number;
  height: number;
  /** Null when the backend does not expose the seed used (e.g. DALL-E). */
  seed: number | null;
  backendId: string;
  /** DALL-E 3 may rewrite the prompt — stored here for transparency. */
  revisedPrompt?: string | null;
}

export interface ImageGenRuntime extends CapabilityRuntime {
  readonly capabilityType: "image-gen";

  /**
   * Submit an image generation request and wait for the result.
   * Adapters MUST throw CapabilityUpstreamError on upstream failure
   * rather than returning partial / empty results.
   */
  generate(
    ctx: TenantContext,
    req: ImageGenRequest,
    apiKey?: string | null,
  ): Promise<ImageGenResult>;
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

/**
 * Embeddings backend — converts raw text into a float vector.
 * The embedding dimension is backend-specific.
 */
export interface EmbeddingsRuntime extends CapabilityRuntime {
  readonly capabilityType: "embeddings";
  /** Default model name used by this backend (e.g. "nomic-embed-text"). */
  readonly defaultModel: string;
  /** Embed a single text string and return the float vector. */
  embed(ctx: TenantContext, text: string, apiKey?: string | null): Promise<number[]>;
}

/**
 * Item stored or returned by a vector store backend.
 */
export interface VectorStoreItem {
  /** Unique ID for the chunk — used to correlate back to SQLite rows. */
  id: string;
  /** The embedding vector for this item. */
  vector: number[];
  /** Arbitrary JSON payload stored alongside the vector (e.g. documentId, chunkPosition). */
  payload: Record<string, unknown>;
}

/**
 * Search result from a vector store backend.
 */
export interface VectorStoreHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

/**
 * Vector store backend — persists vectors and runs ANN similarity search.
 * Each tenant's knowledge base uses a dedicated collection named after the tenantId.
 */
export interface VectorStoreRuntime extends CapabilityRuntime {
  readonly capabilityType: "vector-store";
  /**
   * Create the collection if it does not already exist.
   * `dimension` must match the embedding model's output dimension.
   */
  ensureCollection(ctx: TenantContext, dimension: number, apiKey?: string | null): Promise<void>;
  /** Upsert one or more items into the collection. */
  upsert(ctx: TenantContext, items: VectorStoreItem[], apiKey?: string | null): Promise<void>;
  /** Similarity search — returns the top-K nearest neighbours. */
  search(
    ctx: TenantContext,
    vector: number[],
    topK: number,
    apiKey?: string | null,
  ): Promise<VectorStoreHit[]>;
  /** Remove all vectors for a given chunk ID. */
  delete(ctx: TenantContext, ids: string[], apiKey?: string | null): Promise<void>;
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
