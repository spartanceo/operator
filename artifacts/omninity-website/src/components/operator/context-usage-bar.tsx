/**
 * Context-usage bar shown above the chat composer (Task #51).
 *
 * Tells the user how much of the active model's context window is in
 * play right now. Colour ramps amber at 70 %, red at 90 %, and the
 * whole strip becomes a destructive banner once the prompt overflows.
 *
 * Pure presentational — the parent fetches `/conversations/:id/context`
 * and passes the envelope. We render nothing when no usage data is
 * available so empty conversations don't leak placeholder UI.
 */
import { Pin, Sparkles, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ContextUsageBarProps {
  usage: {
    contextWindow: number;
    usedTokens: number;
    inputBudget: number;
    pct: number;
    summariseAtPct: number;
    status: "ok" | "amber" | "red" | "overflow";
    hasSummary: boolean;
    pinnedCount: number;
    effectiveMessageCount: number;
  } | null;
  onReset?: () => void;
  busy?: boolean;
  modelName?: string | null;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function ContextUsageBar({
  usage,
  onReset,
  busy,
  modelName,
}: ContextUsageBarProps) {
  if (!usage) return null;
  const clampPct = Math.min(usage.pct, 100);
  const barColour =
    usage.status === "overflow"
      ? "bg-destructive"
      : usage.status === "red"
        ? "bg-red-500"
        : usage.status === "amber"
          ? "bg-amber-500"
          : "bg-emerald-500";
  const summaryColour =
    usage.status === "overflow"
      ? "text-destructive"
      : usage.status === "red"
        ? "text-red-600"
        : usage.status === "amber"
          ? "text-amber-600"
          : "text-muted-foreground";
  return (
    <div
      className="mb-2 rounded-md border border-border bg-card/50 px-3 py-2"
      data-testid="context-usage-bar"
      data-usage-status={usage.status}
      data-usage-pct={usage.pct}
    >
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <div className="flex items-center gap-2">
          <span className={cn("font-medium uppercase tracking-wider", summaryColour)}>
            Context
          </span>
          <span className="font-mono text-muted-foreground">
            {formatTokens(usage.usedTokens)} / {formatTokens(usage.inputBudget)} ({usage.pct}%)
          </span>
          {modelName ? (
            <span className="hidden sm:inline text-muted-foreground/80">
              · {modelName} ({formatTokens(usage.contextWindow)} window)
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {usage.pinnedCount > 0 ? (
            <span
              className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary"
              data-testid="context-pinned-count"
            >
              <Pin className="h-3 w-3" /> {usage.pinnedCount} pinned
            </span>
          ) : null}
          {usage.hasSummary ? (
            <span
              className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
              data-testid="context-summary-active"
            >
              <Sparkles className="h-3 w-3" /> summarised
            </span>
          ) : null}
          {onReset ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={onReset}
              disabled={busy}
              data-testid="button-context-reset"
              title="Drop earlier turns from the model's view (transcript stays)"
            >
              Reset context
            </Button>
          ) : null}
        </div>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={usage.pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context window usage"
      >
        <div
          className={cn("h-full transition-all duration-300", barColour)}
          style={{ width: `${clampPct}%` }}
        />
      </div>
      {usage.status === "amber" || usage.status === "red" ? (
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid="context-warning">
          Approaching the {usage.summariseAtPct}% summarisation threshold. Older
          turns will be auto-compressed; pin anything you want to keep verbatim.
        </p>
      ) : null}
      {usage.status === "overflow" ? (
        <p
          className="mt-1 flex items-center gap-1 text-[11px] text-destructive"
          data-testid="context-overflow-warning"
        >
          <AlertTriangle className="h-3 w-3" /> Prompt would exceed the model's
          context window. Try resetting context or chunking your input.
        </p>
      ) : null}
    </div>
  );
}
