/**
 * ComfyUI adapter — local image-generation backend.
 *
 * Wraps ComfyUI's HTTP API:
 *   POST /prompt          — queue a txt2img workflow, returns { prompt_id }
 *   GET  /history/:id     — poll until the job reaches a terminal status
 *   GET  /view            — fetch the generated image bytes
 *
 * Users install ComfyUI separately and point the adapter at their instance
 * (default: http://localhost:8188). The env var COMFYUI_HOST overrides the
 * default.
 *
 * Failures are surfaced as CapabilityUpstreamError — callers convert to
 * structured 503 responses so agents can pause gracefully rather than
 * treating a failed image as a valid empty result.
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type { ImageGenRuntime, ImageGenRequest, ImageGenResult, CapabilityHealth } from "../types";

const DEFAULT_POLL_INTERVAL_MS = 800;
const MAX_POLL_ATTEMPTS = 90; // ~72 s before giving up
const DEFAULT_TIMEOUT_MS = 10_000;

export class CapabilityUpstreamError extends Error {
  readonly code = "CAPABILITY_UPSTREAM";
  constructor(
    public readonly backendId: string,
    public readonly detail: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(`Capability backend "${backendId}" upstream failure: ${detail}`);
  }
}

function host(): string {
  return process.env["COMFYUI_HOST"] ?? "http://127.0.0.1:8188";
}

async function comfyFetch(
  ctx: TenantContext,
  path: string,
  init: RequestInit,
  privacyTarget: string,
): Promise<Response | null> {
  await logPrivacyEvent(ctx, {
    eventType: "network.comfyui",
    actor: ctx.userId ?? ctx.tenantId,
    target: privacyTarget,
    severity: "low",
    detail: (init.method ?? "GET"),
  });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const res = await fetch(`${host()}${path}`, { ...init, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch {
    return null;
  }
}

/**
 * Minimal txt2img ComfyUI workflow graph. The checkpoint name is injected
 * from the request; downstream nodes feed the latent through KSampler and
 * decode to an image using the standard ComfyUI node IDs.
 *
 * Users who need advanced workflows (ControlNet, LoRA, img2img) can swap
 * backends via the switcher — this adapter intentionally keeps the graph
 * minimal so it works against any ComfyUI instance with a single SD checkpoint
 * loaded (e.g. v1-5-pruned-emaonly.safetensors or sd_xl_base_1.0.safetensors).
 */
function buildTxt2ImgWorkflow(
  prompt: string,
  negativePrompt: string,
  checkpoint: string,
  width: number,
  height: number,
  steps: number,
  cfgScale: number,
  seed: number,
): object {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: negativePrompt, clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg: cfgScale,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "omninity" },
    },
  };
}

interface PromptResponse {
  prompt_id?: string;
  error?: string;
}

interface HistoryOutput {
  images?: Array<{ filename: string; subfolder: string; type: string }>;
}

interface HistoryEntry {
  status?: { completed?: boolean; status_str?: string };
  outputs?: Record<string, HistoryOutput>;
}

type HistoryResponse = Record<string, HistoryEntry>;

export const comfyuiAdapter: ImageGenRuntime = {
  id: "comfyui",
  displayName: "ComfyUI (local)",
  capabilityType: "image-gen",
  residency: "local",
  requiresApiKey: false,

  async detect(ctx: TenantContext): Promise<boolean> {
    const res = await comfyFetch(ctx, "/system_stats", { method: "GET" }, "comfyui:detect");
    return Boolean(res && res.ok);
  },

  async health(ctx: TenantContext, _apiKey?: string | null): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    const res = await comfyFetch(ctx, "/system_stats", { method: "GET" }, "comfyui:health");
    if (!res) {
      return {
        status: "unreachable",
        detail: `ComfyUI not reachable at ${host()}. Install ComfyUI and start it, or set COMFYUI_HOST.`,
        detectedAt,
      };
    }
    if (!res.ok) {
      return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
    }
    return { status: "healthy", detail: null, detectedAt };
  },

  async generate(ctx: TenantContext, req: ImageGenRequest): Promise<ImageGenResult> {
    const checkpoint = req.checkpoint ?? "v1-5-pruned-emaonly.safetensors";
    const width = req.width ?? 512;
    const height = req.height ?? 512;
    const steps = req.steps ?? 20;
    const cfgScale = req.cfgScale ?? 7;
    const seed = req.seed ?? Math.floor(Math.random() * 2_147_483_647);
    const negativePrompt = req.negativePrompt ?? "blurry, low quality, watermark, text, logo";

    const workflow = buildTxt2ImgWorkflow(
      req.prompt,
      negativePrompt,
      checkpoint,
      width,
      height,
      steps,
      cfgScale,
      seed,
    );

    const submitCtrl = new AbortController();
    const submitTimer = setTimeout(() => submitCtrl.abort(), DEFAULT_TIMEOUT_MS);
    let submitRes: Response;
    try {
      await logPrivacyEvent(ctx, {
        eventType: "network.comfyui",
        actor: ctx.userId ?? ctx.tenantId,
        target: "comfyui:/prompt",
        severity: "low",
        detail: "POST",
      });
      submitRes = await fetch(`${host()}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
        signal: submitCtrl.signal,
      });
    } catch (e) {
      throw new CapabilityUpstreamError("comfyui", `Failed to submit prompt: ${String(e)}`);
    } finally {
      clearTimeout(submitTimer);
    }

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => "");
      throw new CapabilityUpstreamError("comfyui", `Submit failed HTTP ${submitRes.status}: ${errText}`, submitRes.status);
    }

    const submitJson = (await submitRes.json()) as PromptResponse;
    const promptId = submitJson.prompt_id;
    if (!promptId) {
      throw new CapabilityUpstreamError("comfyui", "ComfyUI returned no prompt_id");
    }

    // Poll /history/:id until the job completes or we time out.
    let historyEntry: HistoryEntry | null = null;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise<void>((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS));
      const histRes = await comfyFetch(ctx, `/history/${promptId}`, { method: "GET" }, `comfyui:/history/${promptId}`);
      if (!histRes || !histRes.ok) continue;
      const histJson = (await histRes.json()) as HistoryResponse;
      const entry = histJson[promptId];
      if (entry?.status?.completed) {
        historyEntry = entry;
        break;
      }
      if (entry?.status?.status_str === "error") {
        throw new CapabilityUpstreamError("comfyui", "ComfyUI reported status error for prompt");
      }
    }

    if (!historyEntry) {
      throw new CapabilityUpstreamError("comfyui", "ComfyUI job timed out — no completed status after polling");
    }

    // Find the first output image across all node outputs.
    const allImages: Array<{ filename: string; subfolder: string; type: string }> = [];
    for (const nodeOutput of Object.values(historyEntry.outputs ?? {})) {
      allImages.push(...(nodeOutput.images ?? []));
    }
    const img = allImages[0];
    if (!img) {
      throw new CapabilityUpstreamError("comfyui", "ComfyUI completed but returned no output images");
    }

    // Fetch the image bytes and convert to base64.
    const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    const viewCtrl = new AbortController();
    const viewTimer = setTimeout(() => viewCtrl.abort(), 30_000);
    let imageBytes: ArrayBuffer;
    try {
      await logPrivacyEvent(ctx, {
        eventType: "network.comfyui",
        actor: ctx.userId ?? ctx.tenantId,
        target: `comfyui:/view?${params.toString()}`,
        severity: "low",
        detail: "GET",
      });
      const viewRes = await fetch(`${host()}/view?${params.toString()}`, { signal: viewCtrl.signal });
      clearTimeout(viewTimer);
      if (!viewRes.ok) {
        throw new CapabilityUpstreamError("comfyui", `Failed to fetch image: HTTP ${viewRes.status}`, viewRes.status);
      }
      imageBytes = await viewRes.arrayBuffer();
    } catch (e) {
      clearTimeout(viewTimer);
      if (e instanceof CapabilityUpstreamError) throw e;
      throw new CapabilityUpstreamError("comfyui", `Failed to download image: ${String(e)}`);
    }

    const b64 = Buffer.from(imageBytes).toString("base64");
    return {
      imageBase64: b64,
      mimeType: "image/png",
      width,
      height,
      seed,
      backendId: "comfyui",
    };
  },
};
