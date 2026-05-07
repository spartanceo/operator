/**
 * Stability AI adapter — cloud image-generation backend.
 *
 * Uses the Stability AI REST API v2beta "Stable Image Core" endpoint.
 * Requires a Stability AI API key stored in the capability credential store
 * (set via POST /api/capabilities/image-gen/stability-ai/credentials).
 *
 * The API returns a PNG as raw bytes; we base64-encode it so the result
 * envelope is consistent with the ComfyUI and DALL-E adapters.
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type { ImageGenRuntime, ImageGenRequest, ImageGenResult, CapabilityHealth } from "../types";
import { CapabilityUpstreamError } from "./comfyui.adapter";

const API_BASE = "https://api.stability.ai";
const GENERATE_URL = `${API_BASE}/v2beta/stable-image/generate/core`;
const DEFAULT_TIMEOUT_MS = 90_000;

type StabilityAspect =
  | "1:1"
  | "16:9"
  | "21:9"
  | "2:3"
  | "3:2"
  | "4:5"
  | "5:4"
  | "9:16"
  | "9:21";

function pickAspect(width?: number, height?: number): StabilityAspect {
  if (!width || !height) return "1:1";
  const ratio = width / height;
  if (ratio >= 1.7) return "16:9";
  if (ratio >= 1.4) return "3:2";
  if (ratio >= 1.1) return "5:4";
  if (ratio <= 0.6) return "9:16";
  if (ratio <= 0.75) return "2:3";
  if (ratio <= 0.9) return "4:5";
  return "1:1";
}

export const stabilityAiAdapter: ImageGenRuntime = {
  id: "stability-ai",
  displayName: "Stability AI",
  capabilityType: "image-gen",
  residency: "cloud-required",
  requiresApiKey: true,

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  },

  async health(ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    if (!apiKey) {
      return { status: "needs-credentials", detail: "Stability AI API key required", detectedAt };
    }
    await logPrivacyEvent(ctx, {
      eventType: "network.stability-ai",
      actor: ctx.userId ?? ctx.tenantId,
      target: "stability-ai:user/balance",
      severity: "medium",
      detail: "GET health-check",
    });
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(`${API_BASE}/v1/user/balance`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 401 || res.status === 403) {
        return { status: "needs-credentials", detail: "API key invalid or insufficient permissions", detectedAt };
      }
      if (!res.ok) {
        return { status: "unreachable", detail: `Stability AI returned HTTP ${res.status}`, detectedAt };
      }
      return { status: "healthy", detail: null, detectedAt };
    } catch {
      return { status: "unreachable", detail: "Could not reach api.stability.ai", detectedAt };
    }
  },

  async generate(ctx: TenantContext, req: ImageGenRequest, apiKey?: string | null): Promise<ImageGenResult> {
    if (!apiKey) {
      throw new CapabilityUpstreamError("stability-ai", "No Stability AI API key configured");
    }

    const aspect = pickAspect(req.width, req.height);

    const form = new FormData();
    form.append("prompt", req.prompt);
    form.append("aspect_ratio", aspect);
    form.append("output_format", "png");
    if (req.negativePrompt) {
      form.append("negative_prompt", req.negativePrompt);
    }
    if (req.seed !== undefined && req.seed !== null) {
      form.append("seed", String(req.seed));
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      await logPrivacyEvent(ctx, {
        eventType: "network.stability-ai",
        actor: ctx.userId ?? ctx.tenantId,
        target: "stability-ai:/v2beta/stable-image/generate/core",
        severity: "high",
        detail: "POST",
      });
      res = await fetch(GENERATE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "image/*" },
        body: form,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(t);
      throw new CapabilityUpstreamError("stability-ai", `Network error: ${String(e)}`);
    }
    clearTimeout(t);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new CapabilityUpstreamError("stability-ai", `HTTP ${res.status}: ${errText}`, res.status);
    }

    const imageBytes = await res.arrayBuffer();
    const b64 = Buffer.from(imageBytes).toString("base64");

    const seedHeader = res.headers.get("seed");
    const returnedSeed = seedHeader ? parseInt(seedHeader, 10) : (req.seed ?? null);

    const [w, h] = aspectToDimensions(aspect);
    return {
      imageBase64: b64,
      mimeType: "image/png",
      width: w,
      height: h,
      seed: isNaN(returnedSeed as number) ? null : (returnedSeed as number),
      backendId: "stability-ai",
      revisedPrompt: null,
    };
  },
};

function aspectToDimensions(aspect: StabilityAspect): [number, number] {
  const map: Record<StabilityAspect, [number, number]> = {
    "1:1": [1024, 1024],
    "16:9": [1344, 768],
    "21:9": [1536, 640],
    "2:3": [832, 1216],
    "3:2": [1216, 832],
    "4:5": [896, 1088],
    "5:4": [1088, 896],
    "9:16": [768, 1344],
    "9:21": [640, 1536],
  };
  return map[aspect] ?? [1024, 1024];
}
