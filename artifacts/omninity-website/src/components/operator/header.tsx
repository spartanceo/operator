import { Sun, Moon, Activity, AlertCircle, HelpCircle, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from "@/contexts/theme-context";
import { useHealthCheck } from "@workspace/api-client-react";
import { useSettings } from "@/contexts/settings-context";
import { useHelp, FeatureHighlight } from "@/components/help";
import { cn } from "@/lib/utils";

interface OperatorHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function OperatorHeader({
  title,
  description,
  actions,
}: OperatorHeaderProps) {
  const { theme, toggle } = useTheme();
  const { settings } = useSettings();
  const { openPanel, openShortcuts } = useHelp();
  const health = useHealthCheck({
    query: { refetchInterval: 15_000 } as never,
  });

  const apiOk = health.data?.success === true;
  const apiPending = health.isLoading;

  return (
    <header className="flex flex-col gap-3 border-b border-border bg-background/80 px-6 py-4 backdrop-blur lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <h1
          className="truncate text-xl font-semibold tracking-tight"
          data-testid="page-title"
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {actions}

        <Badge
          variant="outline"
          className={cn(
            "gap-1.5",
            settings.cloudMode
              ? "text-amber-500 dark:text-amber-400"
              : "text-emerald-600 dark:text-emerald-400",
          )}
          data-testid="badge-mode"
        >
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              settings.cloudMode ? "bg-amber-500" : "bg-emerald-500",
            )}
            aria-hidden="true"
          />
          {settings.cloudMode ? "Cloud" : "Local"}
        </Badge>

        <Badge
          variant="outline"
          className="gap-1.5"
          data-testid="badge-api-status"
        >
          {apiPending ? (
            <Activity
              className="h-3 w-3 animate-pulse"
              aria-hidden="true"
            />
          ) : apiOk ? (
            <Activity
              className="h-3 w-3 text-emerald-500"
              aria-hidden="true"
            />
          ) : (
            <AlertCircle
              className="h-3 w-3 text-destructive"
              aria-hidden="true"
            />
          )}
          {apiPending
            ? "Checking…"
            : apiOk
              ? "API online"
              : "API offline"}
        </Badge>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              aria-label="Open help centre"
              onClick={() => openPanel()}
              data-testid="button-help-open"
              className="relative"
            >
              <HelpCircle className="h-4 w-4" />
              <span className="absolute -right-0.5 -top-0.5">
                <FeatureHighlight highlightId="command-palette-v1" />
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="text-xs">Help · ⌘?</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              aria-label="Show keyboard shortcuts"
              onClick={openShortcuts}
              data-testid="button-shortcuts-open"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="text-xs">Shortcuts · ⌘/</span>
          </TooltipContent>
        </Tooltip>

        <Button
          variant="outline"
          size="icon"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggle}
          data-testid="button-theme-toggle"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
      </div>
    </header>
  );
}
