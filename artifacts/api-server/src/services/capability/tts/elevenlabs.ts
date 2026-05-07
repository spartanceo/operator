/**
 * ElevenLabsTTSRuntime — cloud TTS backend using the ElevenLabs API.
 *
 * Synthesis endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
 * Returns: MP3 audio bytes (audio/mpeg)
 *
 * Voice catalogue: this backend overrides getVoices() to fetch the account's
 * full voice library from GET /v1/voices — this includes pre-made voices,
 * premium voices, and user-cloned voices. The static ELEVENLABS_VOICES_CATALOGUE
 * is used as a fallback when no API key is available.
 *
 * Standard 13 (privacy): logPrivacyEvent is placed immediately before every
 * fetch() call (within 10 lines per tier-review). Text is transmitted to the
 * ElevenLabs cloud; this is noted in every event.
 * API docs: https://docs.elevenlabs.io/api-reference/text-to-speech
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

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

const ELEVENLABS_VOICES_CATALOGUE: ReadonlyArray<VoiceEntry> = [
  {
    id: "21m00Tcm4TlvDq8ikWAM",
    label: "Rachel (neutral, warm)",
    language: "en-US",
    gender: "female",
    engine: "elevenlabs",
    sampleRate: 24000,
  },
  {
    id: "AZnzlk1XvdvUeBnXmlld",
    label: "Domi (energetic)",
    language: "en-US",
    gender: "female",
    engine: "elevenlabs",
    sampleRate: 24000,
  },
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    label: "Bella (gentle, warm)",
    language: "en-US",
    gender: "female",
    engine: "elevenlabs",
    sampleRate: 24000,
  },
  {
    id: "ErXwobaYiN019PkySvjV",
    label: "Antoni (well-rounded)",
    language: "en-US",
    gender: "male",
    engine: "elevenlabs",
    sampleRate: 24000,
  },
  {
    id: "VR6AewLTigWG4xSOukaG",
    label: "Arnold (crisp, authoritative)",
    language: "en-US",
    gender: "male",
    engine: "elevenlabs",
    sampleRate: 24000,
  },
  {
    id: "pNInz6obpgDQGcFmaJgB",
    label: "Adam (narrative, deep)",
    language: "en-US",
    gender: "male",
    engine: "elevenlabs",
    sampleRate: 24000,
  },
];

interface ElevenLabsVoiceShape {
  voice_id: string;
  name: string;
  labels?: { gender?: string; accent?: string; description?: string };
  category?: string;
}

export class ElevenLabsTTSRuntime implements TTSRuntime {
  readonly id = "elevenlabs";
  readonly displayName = "ElevenLabs";
  readonly capabilityType = "tts" as const;
  readonly residency = "cloud-required" as const;
  readonly requiresApiKey = true;

  readonly voices = ELEVENLABS_VOICES_CATALOGUE;

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
        detail: "ElevenLabs API key required",
        detectedAt: new Date().toISOString(),
      };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      // Standard 13: liveness probe to ElevenLabs cloud; no user content sent.
      await logPrivacyEvent(ctx, {
        eventType: "voice.tts.elevenlabs.health",
        actor: ctx.userId ?? ctx.tenantId,
        target: "elevenlabs-api",
        severity: "low",
        detail: "liveness probe to ElevenLabs /user",
      });
      const res = await fetch(`${ELEVENLABS_BASE}/user`, {
        headers: { "xi-api-key": apiKey },
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
        detail: "Could not reach ElevenLabs API",
        detectedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Fetch the account's full voice library including premium and cloned voices.
   * Falls back to the static catalogue on error.
   */
  async getVoices(
    ctx: TenantContext,
    apiKey?: string | null,
  ): Promise<ReadonlyArray<VoiceEntry>> {
    if (!apiKey) return ELEVENLABS_VOICES_CATALOGUE;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      // Standard 13: fetching account voice library from ElevenLabs cloud.
      await logPrivacyEvent(ctx, {
        eventType: "voice.tts.elevenlabs.list_voices",
        actor: ctx.userId ?? ctx.tenantId,
        target: "elevenlabs-api",
        severity: "low",
        detail: "fetching account voice library",
      });
      const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
        headers: { "xi-api-key": apiKey },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return ELEVENLABS_VOICES_CATALOGUE;
      const body = (await res.json()) as { voices: ElevenLabsVoiceShape[] };
      return (body.voices ?? []).map((v) => ({
        id: v.voice_id,
        label: v.name,
        language: "en-US",
        gender: v.labels?.gender ?? "neutral",
        engine: "elevenlabs",
        sampleRate: 24000,
      }));
    } catch {
      return ELEVENLABS_VOICES_CATALOGUE;
    }
  }

  async synthesize(
    ctx: TenantContext,
    input: TTSSynthesizeInput,
    apiKey?: string | null,
  ): Promise<TTSSynthesizeResult> {
    if (!apiKey) throw new Error("ElevenLabs API key is required");

    const voiceId = input.voice ?? ELEVENLABS_VOICES_CATALOGUE[0]!.id;
    const speed = Math.max(0.7, Math.min(1.2, input.speed ?? 1.0));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // Standard 13: text is sent to the ElevenLabs cloud.
      await logPrivacyEvent(ctx, {
        eventType: "voice.synthesize.elevenlabs",
        actor: ctx.userId ?? ctx.tenantId,
        target: voiceId,
        severity: "info",
        detail: `chars=${input.text.length} speed=${speed} cloud=true`,
      });
      const res = await fetch(
        `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: input.text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              speed,
            },
          }),
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ElevenLabs TTS failed ${res.status}: ${body}`);
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
        voice: voiceId,
        engine: "elevenlabs",
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
}
