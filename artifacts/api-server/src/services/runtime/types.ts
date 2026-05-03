/**
 * Model runtime abstraction contract.
 *
 * The Operator must not be hard-wired to any one inference engine. Five
 * local runtimes (Ollama, LM Studio, Jan, llamafile) and two cloud
 * runtimes (OpenAI, Anthropic) all implement this same `ModelRuntime`
 * interface so the chat / agent layer can switch without code changes.
 *
 * Residency taxonomy used by the Privacy Meter:
 *   - "local"          — runs in-process on the user's machine; no network
 *                        traffic leaves the host. (Ollama, LM Studio,
 *                        Jan, llamafile.)
 *   - "cloud-assist"   — primarily cloud, but the user's data leaves the
 *                        machine only on this explicit chat call (no
 *                        background syncing). Used for cloud-key adapters
 *                        when the user has explicitly opted in this session.
 *   - "cloud-required" — always cloud, no local fallback. Same opt-in
 *                        gate as cloud-assist; the distinction is purely
 *                        informational for the meter.
 *
 * Cloud adapters MUST refuse to chat unless `confirmCloudSession` has been
 * called within the current session window. The registry is responsible
 * for enforcing this gate before dispatching to the adapter — adapters
 * themselves trust their inputs.
 */
import type { TenantContext } from "@workspace/types";

export type RuntimeResidency = "local" | "cloud-assist" | "cloud-required";

export interface RuntimeCapabilities {
  /** Token streaming via SSE — currently informational; v1 returns full body. */
  streaming: boolean;
  /** Function/tool calling support in the chat completion API. */
  toolCalling: boolean;
  /** Vision input (image attachments in the chat payload). */
  vision: boolean;
  /** Embedding endpoint exposed by the runtime. */
  embeddings: boolean;
}

export interface RuntimeModel {
  name: string;
  status: "ready" | "pulling" | "missing";
  sizeBytes: number | null;
  family: string | null;
  modifiedAt: string | null;
}

export interface RuntimeChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface RuntimeChatRequest {
  model: string;
  messages: RuntimeChatMessage[];
  temperature?: number;
}

export interface RuntimeChatResult {
  model: string;
  message: RuntimeChatMessage;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface RuntimeChatChunk {
  /** Incremental delta to append to the assistant message. */
  delta: string;
  /** Set on the final chunk only. */
  done: boolean;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface RuntimeEmbedRequest {
  model: string;
  inputs: string[];
}

export interface RuntimeEmbedResult {
  model: string;
  vectors: number[][];
  tokensIn: number | null;
}

export type RuntimeHealthStatus = "healthy" | "unreachable" | "needs-credentials" | "unknown";

export interface RuntimeHealth {
  status: RuntimeHealthStatus;
  detail: string | null;
  detectedAt: string;
}

/**
 * Structured error thrown by an adapter when an upstream call (cloud
 * provider HTTP, local engine socket) fails or returns a non-OK status.
 *
 * Adapters MUST throw this instead of returning a stub assistant
 * message — the runtime service catches it and rethrows as a
 * `RuntimeUnavailableError` so the chat route can return a clean
 * `503 RUNTIME_UNAVAILABLE` and the agent orchestrator can pause and
 * notify (`tool_validation` envelope) instead of silently treating the
 * stub text as a real model response.
 *
 * Defined here in `runtime/types.ts` to avoid a circular import between
 * adapters and `runtime.service.ts`.
 */
export class RuntimeUpstreamError extends Error {
  readonly code = "RUNTIME_UPSTREAM";
  constructor(
    public readonly runtimeId: string,
    public readonly detail: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(`Runtime "${runtimeId}" upstream failure: ${detail}`);
  }
}

/**
 * One inference runtime adapter. All adapters live in
 * `services/runtime/adapters/` so the privacy-log gate (Check #8) sees
 * every outbound `fetch()` paired with a `logPrivacyEvent` within ±10
 * lines.
 *
 * Adapters carry no per-request state — the registry passes a fresh
 * `TenantContext` on every call so the audit log is correctly scoped.
 */
export interface ModelRuntime {
  readonly id: string;
  readonly displayName: string;
  readonly residency: RuntimeResidency;
  readonly requiresApiKey: boolean;
  readonly capabilities: RuntimeCapabilities;

  /**
   * Returns true when the runtime is available on this host. For local
   * adapters this means a quick HTTP probe of the runtime's listen port;
   * for cloud adapters this is always true (their availability is
   * measured by `health()` instead, which checks credentials).
   */
  detect(ctx: TenantContext): Promise<boolean>;

  health(ctx: TenantContext, apiKey?: string | null): Promise<RuntimeHealth>;

  listModels(ctx: TenantContext, apiKey?: string | null): Promise<RuntimeModel[]>;

  chat(
    ctx: TenantContext,
    req: RuntimeChatRequest,
    apiKey?: string | null,
  ): Promise<RuntimeChatResult>;

  /**
   * Streaming chat — yields incremental chunks. Adapters that only
   * support batch responses MAY synthesise a single `done:true` chunk.
   */
  chatStream?(
    ctx: TenantContext,
    req: RuntimeChatRequest,
    apiKey?: string | null,
  ): AsyncIterable<RuntimeChatChunk>;

  /**
   * Embeddings — adapters whose `capabilities.embeddings` is `false`
   * MUST omit this method; the registry surfaces a stable
   * EMBEDDINGS_UNSUPPORTED error in that case.
   */
  embed?(
    ctx: TenantContext,
    req: RuntimeEmbedRequest,
    apiKey?: string | null,
  ): Promise<RuntimeEmbedResult>;

  /**
   * Local-only operation; cloud adapters return a no-op receipt because
   * model selection there happens server-side at the provider.
   */
  pullModel?(
    ctx: TenantContext,
    name: string,
  ): Promise<{ name: string; status: string; scheduledAt: string }>;
}
