/**
 * OpenAITTSRuntime — cloud TTS backend using the OpenAI Audio API.
 *
 * Endpoint: POST https://api.openai.com/v1/audio/speech
 * Model:    tts-1 (fast) or tts-1-hd (higher quality)
 * Returns:  MP3 audio bytes (audio/mpeg)
 *
 * OpenAI TTS voices are fixed by the API; there are no account-specific or
 * cloned voices available through this endpoint.
 *
 * Standard 13 (privacy): logPrivacyEvent is placed immediately before every
 * fetch() call (within 10 lines per tier-review). Text is transmitted to the
 * OpenAI cloud; this is noted in every event.
 * API docs: https://platform.openai.com/docs/api-reference/audio/createSpeech
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type {
  CapabilityHealth,
  TTSRuntime,
  TTSSynthesizeInput,
  TTSSynthesizeResult,
  VoiceEntry,
} from "../types";

const OPENAI_TTS_BASE = "https://api.openai.com/v1/audio/speech";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const OPENAI_TTS_VOICES_CATALOGUE: ReadonlyArray<VoiceEntry> = [
  {
    id: "alloy",
    label: "Alloy (balanced, neutral)",
    language: "en-US",
    gender: "neutral",
    engine: "openai-tts",
    sampleRate: 24000,
  },
  {
    id: "echo",
    label: "Echo (masculine, crisp)",
    language: "en-US",
    gender: "male",
    engine: "openai-tts",
    sampleRate: 24000,
  },
  {
    id: "fable",
    label: "Fable (expressive, British)",
    language: "en-GB",
    gender: "neutral",
    engine: "openai-tts",
    sampleRate: 24000,
  },
  {
    id: "onyx",
    label: "Onyx (deep, authoritative)",
    language: "en-US",
    gender: "male",
    engine: "openai-tts",
    sampleRate: 24000,
  },
  {
    id: "nova",
    label: "Nova (feminine, energetic)",
    language: "en-US",
    gender: "female",
    engine: "openai-tts",
    sampleRate: 24000,
  },
  {
    id: "shimmer",
    label: "Shimmer (warm, gentle)",
    language: "en-US",
    gender: "female",
    engine: "openai-tts",
    sampleRate: 24000,
  },
];

export class OpenAITTSRuntime implements TTSRuntime {
  readonly id = "openai-tts";
  readonly displayName = "OpenAI TTS";
  readonly capabilityType = "tts" as const;
  readonly residency = "cloud-required" as const;
  readonly requiresApiKey = true;

  readonly voices = OPENAI_TTS_VOICES_CATALOGUE;

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  }

  async health(
    ctx: TenantContext,
    apiKey?: string | null,
  ): Promise<CapabilityHealth> {
    if (!apiKey) {
      return {
        status: "needs-credentials",
        detail: "OpenAI API key required",
        detectedAt: new Date().toISOString(),
      };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      // Standard 13: liveness probe to OpenAI cloud; no user content sent.
      await logPrivacyEvent(ctx, {
        eventType: "voice.tts.openai.health",
        actor: ctx.userId ?? ctx.tenantId,
        target: "openai-api",
        severity: "low",
        detail: "liveness probe to OpenAI /models",
      });
      const res = await fetch(OPENAI_MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return {
        status: res.ok ? "healthy" : "unreachable",
        detail: res.ok ? null : `HTTP ${res.status}`,
        detectedAt: new Date().toISOString(),
      };
    } catch {
      return {
        status: "unreachable",
        detail: "Could not reach OpenAI API",
        detectedAt: new Date().toISOString(),
      };
    }
  }

  async synthesize(
    ctx: TenantContext,
    input: TTSSynthesizeInput,
    apiKey?: string | null,
  ): Promise<TTSSynthesizeResult> {
    if (!apiKey) throw new Error("OpenAI API key is required");

    const voice = input.voice ?? "alloy";
    const speed = Math.max(0.5, Math.min(2.0, input.speed ?? 1.0));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // Standard 13: text is sent to the OpenAI cloud.
      await logPrivacyEvent(ctx, {
        eventType: "voice.synthesize.openai",
        actor: ctx.userId ?? ctx.tenantId,
        target: voice,
        severity: "info",
        detail: `chars=${input.text.length} speed=${speed} cloud=true`,
      });
      const res = await fetch(OPENAI_TTS_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice,
          input: input.text,
          speed,
          response_format: "mp3",
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenAI TTS failed ${res.status}: ${body}`);
      }
      const audioBuffer = Buffer.from(await res.arrayBuffer());
      const durationMs = Math.max(
        200,
        Math.round((audioBuffer.length / 16_000) * 1000),
      );
      return {
        audio: audioBuffer.toString("base64"),
        mimeType: "audio/mpeg",
        durationMs,
        voice,
        engine: "openai-tts",
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
}
