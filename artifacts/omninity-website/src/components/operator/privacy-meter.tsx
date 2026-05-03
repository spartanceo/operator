/**
 * Privacy Meter — colour-coded visual reading of the user's current
 * privacy posture. Used in the Privacy page header and (compact) in the
 * operator sidebar so users can see at a glance whether their session is
 * "fully local" or leaking signal to the outside world.
 */
import { Shield, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PrivacyMeterProps {
  readonly score: number;
  readonly band: "green" | "amber" | "red";
  readonly summary?: string;
  readonly variant?: "full" | "compact";
  readonly className?: string;
}

const BAND_STYLES: Record<
  PrivacyMeterProps["band"],
  { ring: string; text: string; bg: string; icon: typeof Shield; label: string }
> = {
  green: {
    ring: "ring-emerald-500/40",
    text: "text-emerald-500",
    bg: "bg-emerald-500/10",
    icon: ShieldCheck,
    label: "Local-only",
  },
  amber: {
    ring: "ring-amber-500/40",
    text: "text-amber-500",
    bg: "bg-amber-500/10",
    icon: ShieldAlert,
    label: "Some sharing",
  },
  red: {
    ring: "ring-rose-500/40",
    text: "text-rose-500",
    bg: "bg-rose-500/10",
    icon: ShieldX,
    label: "Significant sharing",
  },
};

export function PrivacyMeter({
  score,
  band,
  summary,
  variant = "full",
  className,
}: PrivacyMeterProps) {
  const style = BAND_STYLES[band];
  const Icon = style.icon;
  const clamped = Math.max(0, Math.min(100, Math.round(score)));

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1 text-xs",
          style.bg,
          style.text,
          className,
        )}
        data-testid="privacy-meter-compact"
        title={summary ?? style.label}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-medium tabular-nums">{clamped}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-lg border p-4 ring-2",
        style.ring,
        className,
      )}
      data-testid="privacy-meter"
    >
      <div className={cn("rounded-full p-3", style.bg)}>
        <Icon className={cn("h-7 w-7", style.text)} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-3xl font-semibold tabular-nums", style.text)}>
            {clamped}
          </span>
          <span className="text-sm text-muted-foreground">/ 100</span>
          <span
            className={cn(
              "ms-2 rounded-full px-2 py-0.5 text-xs font-medium",
              style.bg,
              style.text,
            )}
          >
            {style.label}
          </span>
        </div>
        {summary ? (
          <p className="mt-1 text-xs text-muted-foreground">{summary}</p>
        ) : null}
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn("h-full rounded-full transition-all", {
              "bg-emerald-500": band === "green",
              "bg-amber-500": band === "amber",
              "bg-rose-500": band === "red",
            })}
            style={{ width: `${clamped}%` }}
          />
        </div>
      </div>
    </div>
  );
}
