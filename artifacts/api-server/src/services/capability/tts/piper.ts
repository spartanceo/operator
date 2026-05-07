/**
 * PiperTTSRuntime — local TTS backend using Piper TTS.
 *
 * Piper is a fast, high-quality, fully offline neural TTS engine.
 * This adapter calls a piper-http server (https://github.com/rhasspy/piper)
 * running on localhost:5000. The piper-http server exposes:
 *   POST /api/tts  { text, voice_id?, length_scale? }  → WAV bytes
 *
 * If no voice_id is supplied, piper uses whichever voice it was launched
 * with. We pass the voice_id from the catalogue so the user's selection
 * is honoured.
 *
 * length_scale controls speaking speed: 1.0 = normal, >1.0 = slower,
 * <1.0 = faster. We invert the user's `speed` value (speed 2.0 →
 * length_scale 0.5) to match the Piper convention.
 *
 * Voice model files (.onnx + .onnx.json) are managed by piper-models.ts
 * which fetches them from the rhasspy/piper-voices HuggingFace repository.
 *
 * Standard 13 (privacy): logPrivacyEvent is placed immediately before every
 * fetch() call (within 10 lines per tier-review). All piper-http calls are
 * local — no audio/text data leaves the host.
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
import { isModelInstalled } from "./piper-models";
import { ensureDefaultVoice } from "./piper-models";

export const PIPER_HOST = "http://localhost:5000";

export const PIPER_RELEASES_URL =
  "https://github.com/rhasspy/piper/releases";

export interface PiperVoiceEntry {
  id: string;
  label: string;
  language: string;
  gender: string;
  sampleRate: number;
}

export const PIPER_VOICES: ReadonlyArray<PiperVoiceEntry> = [
  {
    id: "en_US-lessac-medium",
    label: "Lessac (warm, neutral) — US English",
    language: "en-US",
    gender: "neutral",
    sampleRate: 22050,
  },
  {
    id: "en_US-amy-medium",
    label: "Amy (bright, feminine) — US English",
    language: "en-US",
    gender: "female",
    sampleRate: 22050,
  },
  {
    id: "en_US-ryan-medium",
    label: "Ryan (deep, masculine) — US English",
    language: "en-US",
    gender: "male",
    sampleRate: 22050,
  },
  {
    id: "en_US-kathleen-low",
    label: "Kathleen (clear, neutral) — US English",
    language: "en-US",
    gender: "neutral",
    sampleRate: 16000,
  },
  {
    id: "en_GB-alan-medium",
    label: "Alan (calm, male) — UK English",
    language: "en-GB",
    gender: "male",
    sampleRate: 22050,
  },
  {
    id: "en_GB-jenny_dioco-medium",
    label: "Jenny (energetic, female) — UK English",
    language: "en-GB",
    gender: "female",
    sampleRate: 22050,
  },
];

/**
 * Parse the WAV header to estimate playback duration.
 * WAV canonical header offsets:
 *   22 — num channels (2 bytes)
 *   24 — sample rate  (4 bytes)
 *   34 — bits/sample  (2 bytes)
 *   40 — data size    (4 bytes)
 */
function estimateDurationFromWav(buf: Buffer): number {
  if (buf.length < 44) return 500;
  try {
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
    const numChannels = buf.readUInt16LE(22);
    const dataSize = buf.readUInt32LE(40);
    if (sampleRate === 0 || bitsPerSample === 0 || numChannels === 0) return 500;
    const bytesPerSample = bitsPerSample / 8;
    const totalSamples = dataSize / (numChannels * bytesPerSample);
    return Math.max(100, Math.round((totalSamples / sampleRate) * 1000));
  } catch {
    return 500;
  }
}

export class PiperTTSRuntime implements TTSRuntime {
  readonly id = "piper-tts";
  readonly displayName = "Piper TTS (local)";
  readonly capabilityType = "tts" as const;
  readonly residency = "local" as const;
  readonly requiresApiKey = false;

  readonly voices: ReadonlyArray<VoiceEntry> = PIPER_VOICES.map((v) => ({
    id: v.id,
    label: v.label,
    language: v.language,
    gender: v.gender,
    engine: "piper",
    sampleRate: v.sampleRate,
  }));

  async detect(ctx: TenantContext): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      // Standard 13: liveness probe to local piper-http — no user data sent.
      await logPrivacyEvent(ctx, {
        eventType: "voice.tts.piper.detect",
        actor: ctx.userId ?? ctx.tenantId,
        target: "localhost:5000",
        severity: "low",
        detail: "liveness probe to local piper-http",
      });
      const res = await fetch(`${PIPER_HOST}/`, { signal: controller.signal });
      clearTimeout(timer);
      const detected = res.status < 500;
      if (detected) {
        // Kick off the default voice download in the background so it's
        // ready for the first synthesis request. Non-blocking.
        void ensureDefaultVoice();
      }
      return detected;
    } catch {
      return false;
    }
  }

  async health(ctx: TenantContext, _apiKey?: string | null): Promise<CapabilityHealth> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      // Standard 13: liveness probe to local piper-http — no user data sent.
      await logPrivacyEvent(ctx, {
        eventType: "voice.tts.piper.health",
        actor: ctx.userId ?? ctx.tenantId,
        target: "localhost:5000",
        severity: "low",
        detail: "health check to local piper-http",
      });
      const res = await fetch(`${PIPER_HOST}/`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status < 500) {
        return {
          status: "healthy",
          detail: null,
          detectedAt: new Date().toISOString(),
        };
      }
    } catch {
      /* fall through to unreachable */
    }
    const hasDefault = isModelInstalled("en_US-lessac-medium");
    return {
      status: "unreachable",
      detail: hasDefault
        ? "Start piper-http on port 5000 — voice models are ready"
        : "Start piper-http on port 5000 and download a voice model from Settings",
      detectedAt: new Date().toISOString(),
    };
  }

  async synthesize(
    ctx: TenantContext,
    input: TTSSynthesizeInput,
    _apiKey?: string | null,
  ): Promise<TTSSynthesizeResult> {
    const voiceId = input.voice ?? PIPER_VOICES[0]!.id;
    const speed = Math.max(0.5, Math.min(2.0, input.speed ?? 1.0));
    const lengthScale = 1.0 / speed;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // Standard 13: local-only call — no audio data leaves this host.
      await logPrivacyEvent(ctx, {
        eventType: "voice.synthesize.piper",
        actor: ctx.userId ?? ctx.tenantId,
        target: voiceId,
        severity: "info",
        detail: `chars=${input.text.length} speed=${speed} local=true`,
      });
      const res = await fetch(`${PIPER_HOST}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: input.text,
          voice_id: voiceId,
          length_scale: lengthScale,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`Piper HTTP returned ${res.status}`);
      }
      const audioBuffer = Buffer.from(await res.arrayBuffer());
      const durationMs = estimateDurationFromWav(audioBuffer);
      return {
        audio: audioBuffer.toString("base64"),
        mimeType: "audio/wav",
        durationMs,
        voice: voiceId,
        engine: "piper",
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
}
