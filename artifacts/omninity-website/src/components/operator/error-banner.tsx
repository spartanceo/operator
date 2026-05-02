import { AlertCircle, AlertTriangle, Info, OctagonAlert } from "lucide-react";
import { ApiError } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { describeErrorCode, type ErrorSeverity } from "@/lib/error-catalog";

interface ErrorBannerProps {
  error: unknown;
  className?: string;
  title?: string;
  /** Hide the technical error code chip (defaults to false). */
  hideCode?: boolean;
}

interface Described {
  code?: string;
  rawMessage?: string;
}

function describe(error: unknown): Described {
  if (error instanceof ApiError) {
    const data = error.data as { error?: { code?: string; message?: string } } | null;
    const code = data?.error?.code;
    const message = data?.error?.message ?? error.message;
    const result: Described = {};
    if (code) result.code = code;
    if (message) result.rawMessage = message;
    return result;
  }
  if (error instanceof Error) {
    return { rawMessage: error.message };
  }
  return {};
}

const SEVERITY_STYLES: Record<
  ErrorSeverity,
  { wrap: string; icon: string; Icon: typeof AlertTriangle }
> = {
  info: {
    wrap: "border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-200",
    icon: "text-sky-500",
    Icon: Info,
  },
  warning: {
    wrap: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    icon: "text-amber-500",
    Icon: AlertTriangle,
  },
  error: {
    wrap: "border-destructive/40 bg-destructive/10 text-destructive",
    icon: "text-destructive",
    Icon: AlertCircle,
  },
  critical: {
    wrap: "border-destructive bg-destructive/15 text-destructive",
    icon: "text-destructive",
    Icon: OctagonAlert,
  },
};

export function ErrorBanner({
  error,
  className,
  title,
  hideCode = false,
}: ErrorBannerProps) {
  if (!error) return null;

  const { code, rawMessage } = describe(error);
  const entry = describeErrorCode(code);

  // Always prefer the catalog message (plain English). Only fall back to the
  // server-supplied message if it was explicitly safe to expose AND the code
  // wasn't in the catalog.
  const useRaw = !entry.knownCode && Boolean(rawMessage);
  const displayMessage = useRaw ? rawMessage! : entry.message;
  const action = entry.action;
  const styles = SEVERITY_STYLES[entry.severity];
  const Icon = styles.Icon;

  return (
    <div
      role="alert"
      data-testid="error-banner"
      className={cn(
        "flex items-start gap-3 rounded-md border p-3 text-sm",
        styles.wrap,
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", styles.icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {title ?? defaultTitle(entry.severity)}
          {!hideCode && code ? (
            <span className="ml-1 font-mono text-[10px] opacity-60">[{code}]</span>
          ) : null}
        </p>
        <p className="mt-0.5 break-words text-foreground/80">{displayMessage}</p>
        {action ? (
          <p className="mt-1 text-xs text-foreground/70">{action}</p>
        ) : null}
      </div>
    </div>
  );
}

function defaultTitle(severity: ErrorSeverity): string {
  switch (severity) {
    case "info":
      return "Heads up";
    case "warning":
      return "Something needs attention";
    case "critical":
      return "Critical problem";
    default:
      return "Something went wrong";
  }
}
