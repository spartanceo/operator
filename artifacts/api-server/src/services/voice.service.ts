/**
 * Voice service — Tier 1 stubs for STT (Whisper) and TTS (Kokoro/Coqui).
 *
 * The native binaries land with the dedicated Voice runtime task later in
 * the roadmap. For Tier 1 we expose a deterministic API surface so the UI
 * voice loop (mic capture → transcribe → playback → waveform) can be built,
 * tested, and demoed before the on-device models are bundled.
 *
 * What's deterministic vs. real here:
 *   - `transcribe()`: returns a fixed, audio-length-derived transcript.
 *     The byte length of the input drives the duration so e2e tests can
 *     assert the round-trip without owning a real Whisper model.
 *   - `synthesize()`: returns a *real* WAV (procedural sine envelope sized
 *     to the text). This means the frontend audio player + waveform
 *     animation work end-to-end without the native voice engine.
 *   - `listVoices()`: returns the static catalogue we plan to ship in Tier
 *     2 so the settings UI can render a stable list today.
 *
 * Standards:
 *   - Standard 8: every external/expensive call is bounded — for the stubs
 *     we cap synthesised audio at `MAX_TEXT_CHARS` and transcript bytes at
 *     `MAX_AUDIO_BYTES`.
 *   - Standard 13 (privacy): each call writes a privacy event so the audit
 *     log shows exactly when a microphone capture or speech render happened.
 */
import type { TenantContext } from "@workspace/types";

import { getConnectedProvider } from "./integrations.service";
import { logPrivacyEvent } from "./privacy.service";

const SAMPLE_RATE = 16_000;
const STUB_MODEL = "whisper-stub-tier1";
const STUB_ENGINE = "kokoro-stub-tier1";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB upper bound on a single clip.
export const MAX_TEXT_CHARS = 4_000; // Mirrors the OpenAPI request maxLength.

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

const VOICE_CATALOGUE: ReadonlyArray<VoiceEntry> = [
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

function defaultVoice(): VoiceEntry {
  // The catalogue is non-empty by construction.
  return VOICE_CATALOGUE[0]!;
}

function decodeAudio(audio: string): Buffer {
  // We accept both raw base64 and `data:` URLs so the frontend can use the
  // most natural API for each browser MediaRecorder output.
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

/**
 * Stub transcript generator — deterministic and length-aware so unit tests
 * can assert against the result without needing a real model. We pick the
 * canned response from a small set keyed on the audio byte length so two
 * callers with different recordings get different transcripts.
 */
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

/**
 * Attempt Whisper transcription via Replicate when the tenant has the
 * Replicate provider connected. Returns null on any failure so the caller
 * falls back to the stub transcript.
 */
async function transcribeWithReplicate(
  ctx: TenantContext,
  audio: Buffer,
  mimeType: string,
  language?: string,
): Promise<{ transcript: string; durationMs: number } | null> {
  const creds = await getConnectedProvider(ctx, "replicate");
  if (!creds) return null;
  const token = creds["apiKey"] as string;

  // Encode as a data URL so Replicate can accept it inline.
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

    // Poll if the synchronous wait didn't resolve.
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
  // Approximate the clip length: webm/opus averages ~16 KB/sec at 16 kHz mono.
  const durationMs = Math.max(250, Math.round((audio.length / 16_000) * 1000));

  // Attempt real Whisper transcription via Replicate when connected.
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

  // Fall back to deterministic stub when Replicate is not connected.
  const transcript = pickStubTranscript(audio);
  // Privacy log adjacent to the external call surface — Standard 13.
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

/**
 * Build a 16 kHz mono PCM16 WAV in memory whose duration tracks the text.
 *
 * The waveform is a slow sine envelope so the playback UI gets visible
 * variation across the clip without sounding like noise. Real Kokoro/Coqui
 * output replaces this entire function in the runtime task.
 */
function buildWav(text: string, speed: number): { audio: Buffer; durationMs: number } {
  // Roughly 14 chars/sec at speed 1.0 — slightly slower than natural so
  // long replies feel paced. Speed scales linearly between 0.5x and 2x.
  const charsPerSec = 14 * Math.max(0.5, Math.min(2, speed));
  const seconds = Math.max(0.6, text.length / charsPerSec);
  const totalSamples = Math.round(seconds * SAMPLE_RATE);
  const data = Buffer.alloc(totalSamples * 2); // 16-bit PCM
  // Use a few stacked sines so the waveform isn't a pure tone.
  const baseHz = 180; // low, voice-like fundamental
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = 0.4 * Math.sin(Math.PI * (t / seconds)); // fade in/out
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
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return {
    audio: Buffer.concat([header, data]),
    durationMs: Math.round(seconds * 1000),
  };
}

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
  const voice =
    VOICE_CATALOGUE.find((v) => v.id === input.voice) ?? defaultVoice();
  const speed = input.speed ?? 1.0;
  const { audio, durationMs } = buildWav(input.text, speed);
  await logPrivacyEvent(ctx, {
    eventType: "voice.synthesize",
    actor: ctx.userId ?? ctx.tenantId,
    target: voice.id,
    severity: "info",
    detail: `chars=${input.text.length} ms=${durationMs}`,
  });
  return {
    audio: audio.toString("base64"),
    mimeType: "audio/wav",
    durationMs,
    voice: voice.id,
    engine: voice.engine,
  };
}

export interface VoicePage {
  items: VoiceEntry[];
  nextCursor: string | null;
}

/**
 * Cursor-paginated voice catalogue. The catalogue is small and static so
 * the cursor is just the next index; once we ship the real engine the
 * catalogue becomes dynamic and keyset pagination will replace this.
 */
export function listVoices(opts: { cursor?: string; limit?: number } = {}): VoicePage {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const start = opts.cursor ? Math.max(0, Number(opts.cursor) || 0) : 0;
  const slice = VOICE_CATALOGUE.slice(start, start + limit);
  const next = start + slice.length;
  return {
    items: [...slice],
    nextCursor: next < VOICE_CATALOGUE.length ? String(next) : null,
  };
}
