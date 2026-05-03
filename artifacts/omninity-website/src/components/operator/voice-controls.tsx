/**
 * Voice UI primitives — mic button, waveform, voice mode toggle.
 *
 * These components are dumb visuals; the recording/playback/wake-word
 * lifecycles live in `lib/voice-engine.ts`. Splitting them this way keeps
 * the chat page declarative ("when recording is true, animate the
 * waveform") and lets the hooks be unit-testable in isolation.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, StopCircle, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Waveform — 14 vertical bars whose heights track `level` (0..1).
// ---------------------------------------------------------------------------

interface WaveformProps {
  active: boolean;
  level: number;
  variant?: "input" | "output";
  className?: string;
}

const BAR_COUNT = 14;

export function Waveform({
  active,
  level,
  variant = "input",
  className,
}: WaveformProps) {
  // Smoothed level so the bars don't jitter.
  const [smooth, setSmooth] = useState(0);
  useEffect(() => {
    setSmooth((s) => s * 0.4 + level * 0.6);
  }, [level]);

  const tint =
    variant === "output"
      ? "bg-primary/80"
      : active
        ? "bg-emerald-500"
        : "bg-muted-foreground/40";

  return (
    <div
      className={cn(
        "flex h-8 items-end gap-[2px] rounded-md px-2",
        active ? "bg-muted/50" : "bg-transparent",
        className,
      )}
      data-testid="voice-waveform"
      data-active={active ? "true" : "false"}
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        const phase = (i / BAR_COUNT) * Math.PI * 2;
        const wave = active ? 0.4 + Math.abs(Math.sin(phase + smooth * 6)) : 0.15;
        const h = Math.max(0.1, Math.min(1, wave * (active ? 0.4 + smooth : 0.2)));
        return (
          <span
            key={i}
            className={cn("w-[3px] rounded-full transition-[height] duration-75", tint)}
            style={{ height: `${Math.round(h * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MicButton — hold-to-speak with click-to-toggle fallback for touch.
// ---------------------------------------------------------------------------

interface MicButtonProps {
  isRecording: boolean;
  isBusy?: boolean;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel?: () => void;
}

export function MicButton({
  isRecording,
  isBusy,
  disabled,
  onStart,
  onStop,
  onCancel,
}: MicButtonProps) {
  // Track whether the press began on this button so a release outside
  // the button still finalises the recording (and we don't double-stop
  // when both pointerup and click fire).
  const pressedRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || isBusy) return;
    e.preventDefault();
    pressedRef.current = true;
    if (!isRecording) onStart();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressedRef.current) return;
    e.preventDefault();
    pressedRef.current = false;
    if (isRecording) onStop();
  };

  const handlePointerLeave = () => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    if (isRecording) onStop();
  };

  const handleClick = () => {
    // Pointerdown handles the start path; this catches taps on devices
    // that synthesise click without a preceding pointerdown sequence.
    if (pressedRef.current) return;
    if (isRecording) {
      onStop();
    } else if (!disabled && !isBusy) {
      onStart();
    }
  };

  return (
    <Button
      type="button"
      size="icon"
      variant={isRecording ? "default" : "outline"}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
      onContextMenu={(e) => {
        if (onCancel && isRecording) {
          e.preventDefault();
          onCancel();
        }
      }}
      disabled={disabled || isBusy}
      aria-pressed={isRecording}
      aria-label={isRecording ? "Stop recording" : "Hold to speak"}
      data-testid="button-mic"
      data-recording={isRecording ? "true" : "false"}
      className={cn(
        isRecording &&
          "bg-emerald-500 text-white hover:bg-emerald-500/90 ring-2 ring-emerald-500/40",
      )}
    >
      {isRecording ? (
        <StopCircle className="h-4 w-4" aria-hidden="true" />
      ) : disabled ? (
        <MicOff className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Mic className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// VoiceModeToggle — header switch that turns the voice loop on/off.
// ---------------------------------------------------------------------------

interface VoiceModeToggleProps {
  enabled: boolean;
  onChange: (next: boolean) => void;
  isPlaying?: boolean;
  onInterrupt?: () => void;
}

export function VoiceModeToggle({
  enabled,
  onChange,
  isPlaying,
  onInterrupt,
}: VoiceModeToggleProps) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        id="voice-mode"
        checked={enabled}
        onCheckedChange={onChange}
        data-testid="switch-voice-mode"
      />
      <label
        htmlFor="voice-mode"
        className="flex cursor-pointer select-none items-center gap-1 text-sm text-muted-foreground"
      >
        {enabled ? (
          <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Voice
      </label>
      {isPlaying ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onInterrupt}
          data-testid="button-interrupt-speech"
          className="h-7 px-2 text-xs"
        >
          Interrupt
        </Button>
      ) : null}
    </div>
  );
}
