/**
 * OpenAI-compatible adapter factory — used by LM Studio, Jan, and
 * llamafile, all of which expose an OpenAI-compatible REST surface at
 * `/v1/models` and `/v1/chat/completions`.
 *
 * Each runtime gets its own adapter object built from this factory with
 * the right id/displayName/host so the registry can present them as
 * distinct entries even though the wire protocol is identical.
 *
 * Every fetch() in this file is paired with logPrivacyEvent() within ±10
 * lines so the tier-review privacy gate (Check #8) sees the audit pairing.
 */
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "../../privacy.service";
import type { ModelRuntime, RuntimeChatRequest, RuntimeChatResult, RuntimeHealth, RuntimeModel } from "../types";

const DEFAULT_TIMEOUT_MS = 60_000;

interface OpenAiModelsResp {
  data?: Array<{ id?: string; created?: number; owned_by?: string }>;
}

interface OpenAiChatResp {
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface CompatConfig {
  id: string;
  displayName: string;
  hostEnv: string;
  defaultHost: string;
  /** Default model when the chat call doesn't specify one (e.g. llamafile). */
  fallbackModel?: string;
}

export function createOpenAiCompatAdapter(cfg: CompatConfig): ModelRuntime {
  function host(): string {
    return process.env[cfg.hostEnv] ?? cfg.defaultHost;
  }

  async function compatFetch(
    ctx: TenantContext,
    url: string,
    init: RequestInit,
    privacyTarget: string,
  ): Promise<Response | null> {
    // Privacy log adjacent to the network call so Check #8 sees the pair.
    await logPrivacyEvent(ctx, {
      eventType: `network.${cfg.id}`,
      actor: ctx.userId ?? ctx.tenantId,
      target: privacyTarget,
      severity: "low",
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

  return {
    id: cfg.id,
    displayName: cfg.displayName,
    residency: "local",
    requiresApiKey: false,
    capabilities: {
      streaming: false,
      toolCalling: false,
      vision: false,
      embeddings: false,
    },

    async detect(ctx) {
      const res = await compatFetch(
        ctx,
        `${host()}/v1/models`,
        { method: "GET" },
        `${cfg.id}:detect`,
      );
      return Boolean(res && res.ok);
    },

    async health(ctx): Promise<RuntimeHealth> {
      const res = await compatFetch(
        ctx,
        `${host()}/v1/models`,
        { method: "GET" },
        `${cfg.id}:health`,
      );
      const detectedAt = new Date().toISOString();
      if (!res) return { status: "unreachable", detail: `${cfg.displayName} not reachable at ${host()}`, detectedAt };
      if (!res.ok) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
      return { status: "healthy", detail: null, detectedAt };
    },

    async listModels(ctx): Promise<RuntimeModel[]> {
      const res = await compatFetch(
        ctx,
        `${host()}/v1/models`,
        { method: "GET" },
        `${cfg.id}:/v1/models`,
      );
      if (!res || !res.ok) {
        // llamafile single-binary deployments often skip /v1/models; fall back
        // to a synthetic entry so the picker still works.
        if (cfg.fallbackModel) {
          return [
            {
              name: cfg.fallbackModel,
              status: "ready",
              sizeBytes: null,
              family: cfg.id,
              modifiedAt: null,
            },
          ];
        }
        return [];
      }
      const json = (await res.json()) as OpenAiModelsResp;
      return (json.data ?? []).map((m) => ({
        name: m.id ?? "unknown",
        status: "ready" as const,
        sizeBytes: null,
        family: m.owned_by ?? null,
        modifiedAt: typeof m.created === "number" ? new Date(m.created * 1000).toISOString() : null,
      }));
    },

    async chat(ctx, req: RuntimeChatRequest): Promise<RuntimeChatResult> {
      const targetModel = req.model || cfg.fallbackModel || "default";
      const body = {
        model: targetModel,
        messages: req.messages,
        temperature: req.temperature ?? 0.2,
        stream: false,
      };
      const res = await compatFetch(
        ctx,
        `${host()}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        `${cfg.id}:/v1/chat/completions:${targetModel}`,
      );
      if (!res || !res.ok) {
        return {
          model: targetModel,
          message: {
            role: "assistant",
            content: `${cfg.displayName} is not reachable on this host. Returning a deterministic stub reply.`,
          },
          tokensIn: null,
          tokensOut: null,
        };
      }
      const json = (await res.json()) as OpenAiChatResp;
      const choice = json.choices?.[0]?.message;
      return {
        model: json.model ?? targetModel,
        message: {
          role: (choice?.role as RuntimeChatMessageRole) ?? "assistant",
          content: choice?.content ?? "",
        },
        tokensIn: json.usage?.prompt_tokens ?? null,
        tokensOut: json.usage?.completion_tokens ?? null,
      };
    },
  };
}

type RuntimeChatMessageRole = "system" | "user" | "assistant" | "tool";

// Pre-built adapters for each OpenAI-compatible local runtime. Hosts can
// be overridden via env vars at startup so a user with non-default ports
// doesn't need to recompile.
export const lmstudioAdapter: ModelRuntime = createOpenAiCompatAdapter({
  id: "lmstudio",
  displayName: "LM Studio (local)",
  hostEnv: "LMSTUDIO_HOST",
  defaultHost: "http://127.0.0.1:1234",
});

export const janAdapter: ModelRuntime = createOpenAiCompatAdapter({
  id: "jan",
  displayName: "Jan (local)",
  hostEnv: "JAN_HOST",
  defaultHost: "http://127.0.0.1:1337",
});

export const llamafileAdapter: ModelRuntime = createOpenAiCompatAdapter({
  id: "llamafile",
  displayName: "llamafile (local)",
  hostEnv: "LLAMAFILE_HOST",
  defaultHost: "http://127.0.0.1:8080",
  fallbackModel: "llamafile-default",
});
