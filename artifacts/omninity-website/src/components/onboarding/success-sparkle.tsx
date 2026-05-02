import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface SuccessSparkleProps {
  show: boolean;
  message?: string;
  durationMs?: number;
  onDone?: () => void;
}

/**
 * Brief celebratory toast shown the first time a user completes an agent
 * run. Auto-dismisses after `durationMs` and then calls `onDone` so the
 * parent can flip the "first task completed" flag on the server.
 *
 * Pure presentational — no data fetching, no side effects beyond the
 * dismiss timer. Keeps the chat page logic in one place.
 */
export function SuccessSparkle({
  show,
  message = "First task complete — nicely done.",
  durationMs = 3200,
  onDone,
}: SuccessSparkleProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!show) return;
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, durationMs);
    return () => clearTimeout(t);
  }, [show, durationMs, onDone]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast-success-sparkle"
      className={cn(
        "pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2",
        "flex items-center gap-2 rounded-full border border-primary/30 bg-card/90 px-4 py-2",
        "text-sm text-foreground shadow-lg backdrop-blur",
        "animate-in fade-in slide-in-from-bottom-2 duration-300",
      )}
    >
      <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-primary">
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <span>{message}</span>
    </div>
  );
}
