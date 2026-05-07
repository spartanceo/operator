/**
 * DALL-E 3 adapter — cloud image-generation backend via OpenAI's REST API.
 *
 * Requires an OpenAI API key stored in the capability credential store
 * (set via POST /api/capabilities/image-gen/dalle/credentials).
 *
 * Images are returned as base64 (b64_json) to avoid a second network round-trip
 * to download the CDN URL, and because CDN URLs expire after ~1 hour.
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type { ImageGenRuntime, ImageGenRequest, ImageGenResult, CapabilityHealth } from "../types";
import { CapabilityUpstreamError } from "./comfyui.adapter";

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const DEFAULT_TIMEOUT_MS = 90_000; // DALL-E 3 can be slow (~30-60 s)

type DallESize = "1024x1024" | "1024x1792" | "1792x1024";

function pickSize(width?: number, height?: number): DallESize {
  if (width && height && width > height) return "1792x1024";
  if (width && height && height > width) return "1024x1792";
  return "1024x1024";
}

interface DallEResponse {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
  error?: { message?: string; code?: string };
}

export const dalle3Adapter: ImageGenRuntime = {
  id: "dalle",
  displayName: "DALL-E 3 (OpenAI)",
  capabilityType: "image-gen",
  residency: "cloud-required",
  requiresApiKey: true,

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  },

  async health(ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    if (!apiKey) {
      return { status: "needs-credentials", detail: "OpenAI API key required", detectedAt };
    }
    await logPrivacyEvent(ctx, {
      eventType: "network.openai",
      actor: ctx.userId ?? ctx.tenantId,
      target: "openai:models",
      severity: "medium",
      detail: "GET health-check",
    });
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 401) {
        return { status: "needs-credentials", detail: "API key invalid or revoked", detectedAt };
      }
      if (!res.ok) {
        return { status: "unreachable", detail: `OpenAI returned HTTP ${res.status}`, detectedAt };
      }
      return { status: "healthy", detail: null, detectedAt };
    } catch {
      return { status: "unreachable", detail: "Could not reach api.openai.com", detectedAt };
    }
  },

  async generate(ctx: TenantContext, req: ImageGenRequest, apiKey?: string | null): Promise<ImageGenResult> {
    if (!apiKey) {
      throw new CapabilityUpstreamError("dalle", "No OpenAI API key configured");
    }

    const size = pickSize(req.width, req.height);
    const body = {
      model: "dall-e-3",
      prompt: req.prompt,
      n: 1,
      size,
      response_format: "b64_json",
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      await logPrivacyEvent(ctx, {
        eventType: "network.openai",
        actor: ctx.userId ?? ctx.tenantId,
        target: "openai:/v1/images/generations",
        severity: "high",
        detail: "POST dall-e-3",
      });
      res = await fetch(OPENAI_IMAGES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(t);
      throw new CapabilityUpstreamError("dalle", `Network error: ${String(e)}`);
    }
    clearTimeout(t);

    const json = (await res.json()) as DallEResponse;
    if (!res.ok) {
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      throw new CapabilityUpstreamError("dalle", msg, res.status);
    }

    const firstImage = json.data?.[0];
    const b64 = firstImage?.b64_json;
    if (!b64) {
      throw new CapabilityUpstreamError("dalle", "DALL-E 3 returned no image data");
    }

    const [w, h] = size.split("x").map(Number) as [number, number];
    return {
      imageBase64: b64,
      mimeType: "image/png",
      width: w,
      height: h,
      seed: null,
      backendId: "dalle",
      revisedPrompt: firstImage?.revised_prompt ?? null,
    };
  },
};
