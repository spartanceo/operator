/**
 * Voice engine — browser-side microphone, transcription, playback and
 * wake-word hooks for the Operator chat surface (Task #9).
 *
 * All transport happens through the generated React Query hooks
 * (`useTranscribeAudio`, `useSynthesizeSpeech`) so the OpenAPI contract is
 * the single source of truth (Standard 1).
 *
 * Design notes:
 *  - Recording uses MediaRecorder (universal in modern browsers). The audio
 *    blob is base64-encoded before posting to /api/voice/transcribe so the
 *    request body matches the typed schema and avoids multipart parsing.
 *  - Live captions use the Web Speech API (`webkitSpeechRecognition` /
 *    `SpeechRecognition`) for *display only* — the authoritative transcript
 *    comes back from the backend Whisper engine. Live captions degrade to
 *    "no live caption" when the API isn't available (Firefox, non-secure
 *    contexts).
 *  - Playback uses the standard HTMLAudioElement so we get free pause/seek
 *    and mobile autoplay-policy handling. Interrupts call `audio.pause()`
 *    and dispatch an `onInterrupted` callback so the UI can update the
 *    waveform state.
 *  - Wake-word detection is a continuous SpeechRecognition loop that calls
 *    `onWake()` when the configured phrase appears in the rolling
 *    transcript. The phrase is normalised (lowercased, punctuation
 *    stripped) so casual speech matches reliably.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Browser SpeechRecognition typings — DOM lib doesn't ship them yet.
// ---------------------------------------------------------------------------

interface SpeechRecognitionResultLite {
  readonly isFinal: boolean;
  readonly 0: { transcript: string; confidence: number };
}

interface SpeechRecognitionEventLite extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLite>;
}

interface SpeechRecognitionLite extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((this: SpeechRecognitionLite, ev: SpeechRecognitionEventLite) => void) | null;
  onerror: ((this: SpeechRecognitionLite, ev: Event) => void) | null;
  onend: ((this: SpeechRecognitionLite, ev: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLite;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognition() !== null;
}

export function isMicrophoneSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

async function blobToBase64(blob: Blob): Promise<string> {
  // Strip the `data:<mime>;base64,` prefix so the body matches the schema.
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// useVoiceRecorder
// ---------------------------------------------------------------------------

export interface VoiceRecorderState {
  isRecording: boolean;
  liveCaption: string;
  level: number;
  error: string | null;
}

export interface VoiceRecording {
  base64: string;
  mimeType: string;
  durationMs: number;
}

export interface UseVoiceRecorderOptions {
  onRecording?: (rec: VoiceRecording) => void;
  language?: string;
  maxDurationMs?: number;
}

/**
 * Captures microphone audio for the duration of `start()` → `stop()`.
 * Returns the encoded blob via `onRecording` once the chunks flush.
 *
 * The hook also exposes a live (volume) level derived from an
 * AnalyserNode so the waveform UI can animate in real time, plus a live
 * caption string driven by SpeechRecognition where available.
 */
export function useVoiceRecorder(
  opts: UseVoiceRecorderOptions = {},
): VoiceRecorderState & {
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
} {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [state, setState] = useState<VoiceRecorderState>({
    isRecording: false,
    liveCaption: "",
    level: 0,
    error: null,
  });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLite | null>(null);
  const startedAtRef = useRef<number>(0);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        /* noop */
      }
      recognitionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  const startMeter = useCallback(() => {
    const tick = () => {
      const analyser = analyserRef.current;
      if (!analyser) return;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      setState((s) => ({ ...s, level: Math.min(1, rms * 2.5) }));
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (!isMicrophoneSupported()) {
      setState((s) => ({
        ...s,
        error: "Microphone is not available in this browser",
      }));
      return;
    }
    setState({ isRecording: false, liveCaption: "", level: 0, error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickRecorderMime();
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = performance.now();

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const recordedMs = Math.max(1, performance.now() - startedAtRef.current);
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mime || "audio/webm",
        });
        chunksRef.current = [];
        teardown();
        setState((s) => ({ ...s, isRecording: false, level: 0 }));
        if (blob.size > 0) {
          void blobToBase64(blob).then((base64) => {
            optsRef.current.onRecording?.({
              base64,
              mimeType: blob.type || "audio/webm",
              durationMs: Math.round(recordedMs),
            });
          });
        }
      };

      // Audio meter
      const AudioCtxCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtxCtor) {
        const ctx = new AudioCtxCtor();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        analyserRef.current = analyser;
        startMeter();
      }

      // Live captions (best-effort)
      const SR = getSpeechRecognition();
      if (SR) {
        try {
          const rec = new SR();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = optsRef.current.language ?? "en-US";
          rec.onresult = (ev) => {
            let caption = "";
            for (let i = 0; i < ev.results.length; i++) {
              caption += ev.results[i]!["0"].transcript;
            }
            setState((s) => ({ ...s, liveCaption: caption.trim() }));
          };
          rec.onerror = () => {
            /* ignore — captions are best-effort */
          };
          recognitionRef.current = rec;
          rec.start();
        } catch {
          recognitionRef.current = null;
        }
      }

      recorder.start();
      setState((s) => ({ ...s, isRecording: true }));

      const cap = optsRef.current.maxDurationMs ?? 60_000;
      maxTimerRef.current = setTimeout(() => {
        if (recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
        }
      }, cap);
    } catch (e) {
      teardown();
      const msg = e instanceof Error ? e.message : "Microphone error";
      setState({ isRecording: false, liveCaption: "", level: 0, error: msg });
    }
  }, [startMeter, teardown]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      rec.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    chunksRef.current = [];
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      // Replace onstop so we don't emit the cancelled clip.
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
    teardown();
    setState({ isRecording: false, liveCaption: "", level: 0, error: null });
  }, [teardown]);

  return { ...state, start, stop, cancel };
}

// ---------------------------------------------------------------------------
// useVoicePlayer
// ---------------------------------------------------------------------------

export interface VoicePlayerState {
  isPlaying: boolean;
  level: number;
  error: string | null;
}

export function useVoicePlayer(): VoicePlayerState & {
  play: (audioBase64: string, mimeType: string) => Promise<void>;
  stop: () => void;
} {
  const [state, setState] = useState<VoicePlayerState>({
    isPlaying: false,
    level: 0,
    error: null,
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const stop = useCallback(() => {
    cleanup();
    setState({ isPlaying: false, level: 0, error: null });
  }, [cleanup]);

  const play = useCallback(
    async (audioBase64: string, mimeType: string) => {
      stop();
      try {
        // Decode base64 → Blob → Object URL so <audio> can stream it.
        const binary = atob(audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => stop();
        audio.onerror = () =>
          setState({
            isPlaying: false,
            level: 0,
            error: "Playback error",
          });
        // Pseudo-meter from currentTime for the waveform animation.
        tickRef.current = setInterval(() => {
          const t = audio.currentTime;
          const env = 0.4 + 0.5 * Math.abs(Math.sin(t * 6));
          setState((s) => ({ ...s, level: env }));
        }, 80);
        setState({ isPlaying: true, level: 0.5, error: null });
        await audio.play();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not play audio";
        cleanup();
        setState({ isPlaying: false, level: 0, error: msg });
      }
    },
    [cleanup, stop],
  );

  return { ...state, play, stop };
}

// ---------------------------------------------------------------------------
// useWakeWord
// ---------------------------------------------------------------------------

export interface UseWakeWordOptions {
  enabled: boolean;
  phrase: string;
  onWake: () => void;
  language?: string;
}

function normalisePhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function useWakeWord(opts: UseWakeWordOptions): {
  active: boolean;
  supported: boolean;
} {
  const { enabled, phrase, onWake, language } = opts;
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const [active, setActive] = useState(false);
  const supported = isSpeechRecognitionSupported();

  useEffect(() => {
    if (!enabled || !supported) {
      setActive(false);
      return;
    }
    const SR = getSpeechRecognition();
    if (!SR) return;
    const target = normalisePhrase(phrase);
    if (!target) return;

    let recognition: SpeechRecognitionLite | null = null;
    let stopped = false;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let cooldownUntil = 0;

    const startLoop = () => {
      if (stopped) return;
      try {
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = language ?? "en-US";
        rec.onresult = (ev) => {
          let caption = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            caption += ev.results[i]!["0"].transcript + " ";
          }
          const normalised = normalisePhrase(caption);
          if (
            normalised.includes(target) &&
            performance.now() >= cooldownUntil
          ) {
            // Throttle to one wake event per ~2s so a long utterance
            // doesn't trigger multiple recordings.
            cooldownUntil = performance.now() + 2_000;
            onWakeRef.current();
          }
        };
        rec.onerror = () => {
          // Most recoverable errors hit onend immediately after; let the
          // restart path handle it.
        };
        rec.onend = () => {
          if (stopped) return;
          // Browsers stop continuous SpeechRecognition aggressively;
          // restart with a small delay so we don't busy-loop.
          restartTimer = setTimeout(startLoop, 250);
        };
        recognition = rec;
        rec.start();
        setActive(true);
      } catch {
        setActive(false);
      }
    };

    startLoop();

    return () => {
      stopped = true;
      setActive(false);
      if (restartTimer) clearTimeout(restartTimer);
      if (recognition) {
        recognition.onend = null;
        try {
          recognition.abort();
        } catch {
          /* noop */
        }
      }
    };
  }, [enabled, supported, phrase, language]);

  return { active, supported };
}
