import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetOnboardingProfile } from "@workspace/api-client-react";
import { CONTEXT_HINTS, type ContextHint } from "./help-content";

interface InlineHintsProps {
  /** Called with the chosen prompt — the chat page wires this up to the
   *  textarea so a click pre-fills the input without sending. */
  onPick: (prompt: string) => void;
  className?: string;
}

/**
 * Suggested-command chips shown above the chat input when no message
 * has been typed yet. Adapts to the use-case the user picked during
 * onboarding (productivity, sales, coding, …) and falls back to a
 * generic productivity bundle for first-time visitors.
 *
 * Distinct from `StarterChips` (which renders server-personalised
 * starter tasks) — this is a static, client-side suggestion strip
 * that complements the server's tasks.
 */
export function InlineHints({ onPick, className }: InlineHintsProps) {
  const profileQuery = useGetOnboardingProfile();
  const useCase = profileQuery.data?.data.profile?.useCase ?? null;
  const hints: ReadonlyArray<ContextHint> = useCase
    ? CONTEXT_HINTS[useCase] ?? CONTEXT_HINTS["default"]!
    : CONTEXT_HINTS["default"]!;

  if (hints.length === 0) return null;

  return (
    <div
      className={cn("space-y-2", className)}
      data-testid="inline-hints"
    >
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Lightbulb className="h-3 w-3" />
        Try a hint
      </p>
      <div className="flex flex-wrap gap-2">
        {hints.map((hint) => (
          <button
            key={hint.id}
            type="button"
            onClick={() => onPick(hint.prompt)}
            data-testid={`inline-hint-${hint.id}`}
            className="hover-elevate active-elevate-2 rounded-full border border-dashed border-border bg-background/40 px-3 py-1 text-[11px] text-muted-foreground"
          >
            {hint.title}
          </button>
        ))}
      </div>
    </div>
  );
}
