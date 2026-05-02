import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHelp } from "./help-context";

interface HelpIconProps {
  /** Optional article id to scroll to when the help panel opens. */
  articleId?: string;
  /** Accessible label — describes the topic the icon explains. */
  label: string;
  className?: string;
  /** Optional one-line preview shown on hover. */
  hint?: string;
}

/**
 * Small "?" button that anchors next to a feature title or panel header.
 * Click → opens the help panel; if `articleId` is set the panel scrolls
 * straight to that article.
 */
export function HelpIcon({ articleId, label, className, hint }: HelpIconProps) {
  const { openPanel } = useHelp();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openPanel(articleId ?? null)}
          aria-label={`Help: ${label}`}
          data-testid={`help-icon-${articleId ?? label}`}
          className={cn(
            "hover-elevate active-elevate-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground",
            className,
          )}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="text-xs">{hint ?? `Help — ${label}`}</span>
      </TooltipContent>
    </Tooltip>
  );
}
