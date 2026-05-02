import { useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { useCheckForUpdates } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

const DISMISS_STORAGE_PREFIX = "omninity.operator.updateDismissed.";

function loadDismissed(version: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${DISMISS_STORAGE_PREFIX}${version}`) === "1";
  } catch {
    return false;
  }
}

function saveDismissed(version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${DISMISS_STORAGE_PREFIX}${version}`, "1");
  } catch {
    /* storage disabled */
  }
}

/**
 * Subtle one-line banner shown above the operator header when
 * `/api/updates/check` reports a newer version is published. The banner is
 * dismissible per-version (so a user only sees the same release once) and
 * silently no-ops when no update is available — meaning the layout is
 * stable for the 99% of polls that return `updateAvailable=false`.
 */
export function UpdateBanner() {
  const query = useCheckForUpdates({
    query: { refetchInterval: 60_000 } as never,
  });
  const result = query.data?.data;
  const [dismissedNow, setDismissedNow] = useState(false);

  if (!result || !result.updateAvailable) return null;
  if (dismissedNow || loadDismissed(result.latestVersion)) return null;

  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-primary/20 bg-primary/5 px-6 py-2 text-sm text-foreground"
      data-testid="banner-update-available"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ArrowUpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="truncate">
          Omninity Operator{" "}
          <span className="font-mono">{result.latestVersion}</span> is
          available — you're on{" "}
          <span className="font-mono">{result.currentVersion}</span>.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {result.downloadUrl ? (
          <a
            href={result.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            data-testid="link-update-download"
          >
            Download
          </a>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            saveDismissed(result.latestVersion);
            setDismissedNow(true);
          }}
          aria-label="Dismiss update notice"
          data-testid="button-dismiss-update"
          className="h-6 w-6"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
