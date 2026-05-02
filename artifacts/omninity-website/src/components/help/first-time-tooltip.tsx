import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useHelp } from "./help-context";

interface FirstTimeTooltipProps {
  /** Stable identifier — re-using the same id across renders guarantees
   *  the tooltip is shown once per user. */
  id: string;
  title: string;
  body: string;
  children: ReactNode;
  /** When true the tooltip pops on mount. Defaults to true. */
  autoOpen?: boolean;
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Wraps any child node and shows a one-time, dismissable popover the first
 * time it is mounted. Once dismissed (X, Got it, or click-away), the
 * tooltip never shows again for the same `id`.
 */
export function FirstTimeTooltip({
  id,
  title,
  body,
  children,
  autoOpen = true,
  side = "bottom",
}: FirstTimeTooltipProps) {
  const { isTooltipDismissed, dismissTooltip } = useHelp();
  const dismissed = isTooltipDismissed(id);
  const [open, setOpen] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    if (autoOpen && !dismissed) {
      // Small delay so the highlight lands after the surrounding layout
      // has settled — avoids the popover flashing in the wrong place.
      const t = setTimeout(() => setOpen(true), 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [autoOpen, dismissed]);

  const onDismiss = () => {
    dismissTooltip(id);
    setOpen(false);
  };

  return (
    <Popover
      open={open && !dismissed}
      onOpenChange={(next) => {
        if (!next) onDismiss();
        else setOpen(true);
      }}
    >
      <PopoverTrigger asChild>{children as React.ReactElement}</PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        className="w-72 border-primary/30 bg-popover p-0 shadow-lg"
        data-testid={`first-time-tooltip-${id}`}
      >
        <div className="flex items-start justify-between gap-2 border-b border-border/60 p-3">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <button
            type="button"
            aria-label="Dismiss tooltip"
            onClick={onDismiss}
            className="hover-elevate -m-1 rounded-md p-1 text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-3 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
          <button
            type="button"
            onClick={onDismiss}
            className="hover-elevate active-elevate-2 inline-flex h-7 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
            data-testid={`first-time-tooltip-dismiss-${id}`}
          >
            Got it
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
