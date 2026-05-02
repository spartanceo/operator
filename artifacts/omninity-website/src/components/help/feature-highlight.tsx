import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useHelp } from "./help-context";
import { FEATURE_HIGHLIGHTS } from "./help-content";

interface FeatureHighlightProps {
  /** Must match a `FeatureHighlight.id` in `help-content.ts`. */
  highlightId: string;
  className?: string;
}

/**
 * Subtle pulsing dot that draws attention to a newly-added feature.
 * Disappears once the user hovers, clicks, or otherwise interacts with
 * the popover — and is permanently dismissed thereafter.
 */
export function FeatureHighlight({
  highlightId,
  className,
}: FeatureHighlightProps) {
  const { isFeatureSeen, markFeatureSeen } = useHelp();
  const [open, setOpen] = useState(false);

  const highlight = FEATURE_HIGHLIGHTS.find((h) => h.id === highlightId);
  if (!highlight) return null;
  if (isFeatureSeen(highlightId)) return null;

  const Icon = highlight.icon;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) markFeatureSeen(highlightId);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`What's new: ${highlight.title}`}
          data-testid={`feature-highlight-${highlightId}`}
          className={cn(
            "relative inline-flex h-2.5 w-2.5 items-center justify-center",
            className,
          )}
        >
          <span className="absolute inline-block h-2.5 w-2.5 animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-block h-2 w-2 rounded-full bg-primary" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72 p-0">
        <div className="flex items-start gap-2 border-b border-border/60 p-3">
          <div className="rounded-md bg-primary/10 p-1.5 text-primary">
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              New in {highlight.release}
            </p>
            <p className="text-sm font-semibold text-foreground">
              {highlight.title}
            </p>
          </div>
        </div>
        <p className="p-3 text-xs leading-relaxed text-muted-foreground">
          {highlight.body}
        </p>
      </PopoverContent>
    </Popover>
  );
}
