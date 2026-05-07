/**
 * Voice service — STT (Whisper/Replicate) and TTS (Piper / ElevenLabs / OpenAI TTS).
 *
 * TTS routing (synthesize):
 *   1. Resolve the tenant's active TTS backend via the capability registry.
 *   2. Call that backend's synthesize(ctx, input, apiKey) so it can log privacy
 *      events and access credentials.
 *   3. Fall back to the procedural stub WAV when no backend is selected or the
 *      selected backend fails — the voice interface never fully breaks.
 *
 * Voice catalogue (listVoices):
 *   Returns the active backend's voice list via getVoices() (which may make a
 *   live API call for cloud backends to fetch premium/cloned voices), falling
 *   back to the static catalogue or stub catalogue when needed.
 *
 * STT routing (transcribe):
 *   Attempts Replicate Whisper when the tenant has that integration connected.
 *   Falls back to a deterministic stub for e2e-testability without a real model.
 *
 * Standards:
 *   - Standard 8: every external/expensive call is bounded — MAX_TEXT_CHARS,
 *     MAX_AUDIO_BYTES, and per-backend 30s timeouts.
 *   - Standard 13 (privacy): each network call writes a privacy event; the
 *     actual event is logged inside the backend's synthesize() / health() calls.
 */
import type { TenantContext } from "@workspace/types";

import { getActiveTTSContext, getActiveTTSVoices } from "./capability.service";
import { getConnectedProvider } from "./integrations.service";
import { logPrivacyEvent } from "./privacy.service";

const SAMPLE_RATE = 16_000;
const STUB_MODEL = "whisper-stub-tier1";
const STUB_ENGINE = "stub-tier1";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 4_000;

export interface VoiceTranscribeInput {
  audio: string;
  mimeType?: string;
  language?: string;
}

export interface VoiceTranscribeResult {
  transcript: string;
  durationMs: number;
  language: string;
  model: string;
  confidence: number | null;
}

export interface VoiceSynthesizeInput {
  text: string;
  voice?: string;
  speed?: number;
  format?: "wav";
}

export interface VoiceSynthesizeResult {
  audio: string;
  mimeType: string;
  durationMs: number;
  voice: string;
  engine: string;
  /**
   * Set when the configured TTS backend failed and synthesis fell back to the
   * procedural stub. Null on success. Callers should surface this to the user
   * (e.g. "Piper TTS is not reachable — using stub voice") rather than
   * silently delivering stub audio as if the backend had worked.
   */
  engineError: string | null;
}

export interface VoiceEntry {
  id: string;
  label: string;
  language: string;
  gender: string;
  engine: string;
  sampleRate: number | null;
}

export class VoicePayloadError extends Error {
  override readonly name = "VoicePayloadError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Stub voice catalogue — returned when no TTS backend is active. These IDs
 * map to the procedural WAV generator so the UI never shows an empty list.
 */
const STUB_VOICE_CATALOGUE: ReadonlyArray<VoiceEntry> = [
  {
    id: "ember",
    label: "Ember (warm, neutral)",
    language: "en-US",
    gender: "neutral",
    engine: STUB_ENGINE,
    sampleRate: SAMPLE_RATE,
  },
  {
    id: "atlas",
    label: "Atlas (deep, masculine)",
    language: "en-US",
    gender: "male",
    engine: STUB_ENGINE,
    sampleRate: SAMPLE_RATE,
  },
  {
    id: "wren",
    label: "Wren (bright, feminine)",
    language: "en-US",
    gender: "female",
    engine: STUB_ENGINE,
    sampleRate: SAMPLE_RATE,
  },
  {
    id: "harbor",
    label: "Harbor (calm, narrator)",
    language: "en-GB",
    gender: "neutral",
    engine: STUB_ENGINE,
    sampleRate: SAMPLE_RATE,
  },
];

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

function decodeAudio(audio: string): Buffer {
  const stripped = audio.startsWith("data:")
    ? audio.slice(audio.indexOf(",") + 1)
    : audio;
  const buf = Buffer.from(stripped, "base64");
  if (buf.length === 0) {
    throw new VoicePayloadError("VOICE_AUDIO_EMPTY", "Audio payload is empty");
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new VoicePayloadError(
      "VOICE_AUDIO_TOO_LARGE",
      `Audio exceeds the ${Math.round(MAX_AUDIO_BYTES / (1024 * 1024))}MB limit`,
    );
  }
  return buf;
}

// ---------------------------------------------------------------------------
// STT stub
// ---------------------------------------------------------------------------

const STUB_TRANSCRIPTS = [
  "Open the latest privacy report.",
  "Remind me to review the chat agents tomorrow morning.",
  "Summarise the last conversation in three bullet points.",
  "Search my memory for notes about the operator launch.",
  "What did we decide about the voice interface yesterday?",
] as const;

function pickStubTranscript(audio: Buffer): string {
  const idx = audio.length % STUB_TRANSCRIPTS.length;
  return STUB_TRANSCRIPTS[idx]!;
}

async function transcribeWithReplicate(
  ctx: TenantContext,
  audio: Buffer,
  mimeType: string,
  language?: string,
): Promise<{ transcript: string; durationMs: number } | null> {
  const creds = await getConnectedProvider(ctx, "replicate");
  if (!creds) return null;
  const token = creds["apiKey"] as string;

  const b64 = audio.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  interface WhisperPrediction {
    id: string;
    status: string;
    output?: { transcription?: string; segments?: Array<{ end: number }> };
    error?: string;
  }

  try {
    await logPrivacyEvent(ctx, {
      eventType: "voice.transcribe.replicate",
      actor: ctx.userId ?? ctx.tenantId,
      target: mimeType,
      severity: "low",
      detail: `bytes=${audio.length}`,
    });
    const createRes = await fetch(
      "https://api.replicate.com/v1/models/openai/whisper/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "wait=60",
        },
        body: JSON.stringify({
          input: {
            audio: dataUrl,
            model: "large-v3",
            ...(language ? { language } : {}),
          },
        }),
      },
    );

    if (!createRes.ok) {
      const body = await createRes.text().catch(() => "(unreadable)");
      console.warn(`[voice] Replicate Whisper create failed ${createRes.status}: ${body}`);
      return null;
    }

    let prediction = (await createRes.json()) as WhisperPrediction;

    const pollUrl = `https://api.replicate.com/v1/predictions/${prediction.id}`;
    let attempts = 0;
    while (
      prediction.status !== "succeeded" &&
      prediction.status !== "failed" &&
      prediction.status !== "canceled" &&
      attempts < 30
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      await logPrivacyEvent(ctx, {
        eventType: "voice.transcribe.replicate.poll",
        actor: ctx.userId ?? ctx.tenantId,
        target: prediction.id,
        severity: "low",
        detail: `attempt=${attempts}`,
      });
      const pollRes = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      prediction = (await pollRes.json()) as WhisperPrediction;
      attempts++;
    }

    if (prediction.status !== "succeeded" || !prediction.output?.transcription) {
      console.warn(
        `[voice] Replicate Whisper prediction ${prediction.id} ended status=${prediction.status} error=${prediction.error ?? "none"}`,
      );
      return null;
    }

    const segments = prediction.output.segments ?? [];
    const lastEnd = segments.length > 0 ? (segments[segments.length - 1]?.end ?? 0) : 0;
    const durationMs = Math.max(250, Math.round(lastEnd * 1000));

    return { transcript: prediction.output.transcription, durationMs };
  } catch (e) {
    console.warn("[voice] Replicate Whisper fetch error:", e);
    return null;
  }
}

export async function transcribe(
  ctx: TenantContext,
  input: VoiceTranscribeInput,
): Promise<VoiceTranscribeResult> {
  const audio = decodeAudio(input.audio);
  const durationMs = Math.max(250, Math.round((audio.length / 16_000) * 1000));

  const replicateResult = await transcribeWithReplicate(
    ctx,
    audio,
    input.mimeType ?? "audio/webm",
    input.language,
  );
  if (replicateResult) {
    return {
      transcript: replicateResult.transcript,
      durationMs: replicateResult.durationMs,
      language: input.language ?? "en",
      model: "openai/whisper-large-v3",
      confidence: null,
    };
  }

  const transcript = pickStubTranscript(audio);
  await logPrivacyEvent(ctx, {
    eventType: "voice.transcribe",
    actor: ctx.userId ?? ctx.tenantId,
    target: input.mimeType ?? "audio/unknown",
    severity: "low",
    detail: `bytes=${audio.length} ms=${durationMs}`,
  });
  return {
    transcript,
    durationMs,
    language: input.language ?? "en-US",
    model: STUB_MODEL,
    confidence: 0.88,
  };
}

// ---------------------------------------------------------------------------
// TTS — procedural stub fallback (WAV in memory)
// ---------------------------------------------------------------------------

function buildStubWav(text: string, speed: number): { audio: Buffer; durationMs: number } {
  const charsPerSec = 14 * Math.max(0.5, Math.min(2, speed));
  const seconds = Math.max(0.6, text.length / charsPerSec);
  const totalSamples = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(totalSamples * 2);
  const baseHz = 180;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = 0.4 * Math.sin(Math.PI * (t / seconds));
    const wave =
      Math.sin(2 * Math.PI * baseHz * t) * 0.6 +
      Math.sin(2 * Math.PI * (baseHz * 1.5) * t) * 0.3 +
      Math.sin(2 * Math.PI * (baseHz * 2.25) * t) * 0.1;
    const sample = Math.max(-1, Math.min(1, envelope * wave));
    data.writeInt16LE(Math.round(sample * 32_000), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return {
    audio: Buffer.concat([header, data]),
    durationMs: Math.round(seconds * 1000),
  };
}

function defaultStubVoice(): VoiceEntry {
  return STUB_VOICE_CATALOGUE[0]!;
}

// ---------------------------------------------------------------------------
// TTS — synthesize() — routes to active backend, stubs on fallback
// ---------------------------------------------------------------------------

export async function synthesize(
  ctx: TenantContext,
  input: VoiceSynthesizeInput,
): Promise<VoiceSynthesizeResult> {
  if (!input.text || input.text.trim().length === 0) {
    throw new VoicePayloadError("VOICE_TEXT_EMPTY", "Text is required");
  }
  if (input.text.length > MAX_TEXT_CHARS) {
    throw new VoicePayloadError(
      "VOICE_TEXT_TOO_LONG",
      `Text exceeds the ${MAX_TEXT_CHARS}-char limit`,
    );
  }

  const speed = input.speed ?? 1.0;
  let backendError: string | null = null;

  // Attempt real synthesis via the configured TTS backend.
  try {
    const { backend, apiKey } = await getActiveTTSContext(ctx);
    if (backend) {
      // Normalise the requested voice ID to one that the active backend
      // actually supports. If the persisted voice comes from a different
      // backend (e.g. the user switched from stub to Piper), fall back to
      // the first voice in the new backend's catalogue so the switch takes
      // effect immediately without requiring a manual voice re-selection.
      const catalogue = backend.voices;
      const voiceId =
        input.voice && catalogue.some((v) => v.id === input.voice)
          ? input.voice
          : catalogue[0]?.id;
      const result = await backend.synthesize(
        ctx,
        { text: input.text, voice: voiceId, speed },
        apiKey,
      );
      // Backend succeeded — engineError is null so callers know this is real audio.
      return { ...result, engineError: null };
    }
  } catch (e) {
    // Record the backend failure so it appears in the response metadata AND
    // is returned to the caller. Returning engineError in the response body
    // prevents the "silent failure" where the UI receives stub audio with
    // engine="stub-tier1" and no indication that the configured backend
    // (e.g. Piper TTS) failed to respond.
    backendError = e instanceof Error ? e.message : String(e);
    console.warn("[voice] TTS backend error, falling back to stub:", backendError);
  }

  // Stub fallback — procedural WAV so the UI always gets valid audio.
  // engineError is non-null so callers can surface a warning rather than
  // treating stub audio as successful Piper/ElevenLabs synthesis.
  const voice =
    STUB_VOICE_CATALOGUE.find((v) => v.id === input.voice) ?? defaultStubVoice();
  const { audio, durationMs } = buildStubWav(input.text, speed);
  await logPrivacyEvent(ctx, {
    eventType: "voice.synthesize",
    actor: ctx.userId ?? ctx.tenantId,
    target: voice.id,
    severity: "info",
    detail: `engine=stub chars=${input.text.length} ms=${durationMs}${backendError ? ` backend_err=${backendError.slice(0, 80)}` : ""}`,
  });
  return {
    audio: audio.toString("base64"),
    mimeType: "audio/wav",
    durationMs,
    voice: voice.id,
    engine: STUB_ENGINE,
    engineError: backendError,
  };
}

// ---------------------------------------------------------------------------
// Voice catalogue — listVoices()
// ---------------------------------------------------------------------------

export interface VoicePage {
  items: VoiceEntry[];
  nextCursor: string | null;
}

/**
 * Returns the voice catalogue for the tenant's active TTS backend, or the
 * stub catalogue when no backend is configured. For cloud backends with an
 * API key this calls getVoices() which may fetch premium/cloned voices live.
 */
export async function listVoices(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<VoicePage> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const start = opts.cursor ? Math.max(0, Number(opts.cursor) || 0) : 0;

  const backendVoices = await getActiveTTSVoices(ctx);
  const catalogue: ReadonlyArray<VoiceEntry> =
    backendVoices.length > 0 ? backendVoices : STUB_VOICE_CATALOGUE;

  const slice = catalogue.slice(start, start + limit);
  const next = start + slice.length;
  return {
    items: [...slice],
    nextCursor: next < catalogue.length ? String(next) : null,
  };
}
