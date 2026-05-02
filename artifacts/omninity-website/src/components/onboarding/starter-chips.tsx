import { useGetOnboardingStarterTasks } from "@workspace/api-client-react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarterChipsProps {
  onPick: (prompt: string) => void;
  className?: string;
}

/**
 * Personalised starter-task chips shown above the chat input when the
 * conversation is empty. Each chip is keyed off the use-case the user
 * picked during onboarding; for returning users with a stale profile,
 * the API falls back to a generic productivity bundle so the chips are
 * never empty.
 */
export function StarterChips({ onPick, className }: StarterChipsProps) {
  const query = useGetOnboardingStarterTasks();
  const items = query.data?.data.items ?? [];

  if (query.isLoading || items.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)} data-testid="starter-chips">
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        Starter tasks
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onPick(task.prompt)}
            data-testid={`chip-starter-${task.id}`}
            className="group rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover-elevate active-elevate-2"
          >
            <span className="font-medium">{task.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
