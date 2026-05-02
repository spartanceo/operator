/**
 * DiskHealthBanner — visible warning in the operator shell when the local
 * data volume drops below the warning (2 GB) or critical (500 MB) threshold.
 *
 * Implements the user-facing half of Step 5 of Task #31 (Storage and system
 * monitors). Polls /api/diagnostics/disk every 60s; renders nothing when the
 * disk is healthy or the probe couldn't read it (`unknown`).
 */
import { AlertTriangle, OctagonAlert } from "lucide-react";
import { useGetDiagnosticDisk } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DiskHealthBanner() {
  const query = useGetDiagnosticDisk({
    query: { refetchInterval: 60_000, retry: false } as never,
  });

  const status = query.data?.data.status;
  if (!status || status.health === "ok" || status.health === "unknown") return null;

  const isCritical = status.health === "critical";
  const Icon = isCritical ? OctagonAlert : AlertTriangle;
  const free = formatBytes(status.freeBytes);

  return (
    <div
      role="status"
      data-testid="disk-health-banner"
      className={cn(
        "flex items-start gap-3 border-b px-4 py-2 text-sm",
        isCritical
          ? "border-destructive/60 bg-destructive/15 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {isCritical ? "Disk space critically low" : "Disk space running low"}
        </p>
        <p className="mt-0.5 text-xs opacity-90">
          Only {free} free on your local data volume.{" "}
          {isCritical
            ? "Free space soon — model downloads and backups may fail until you do."
            : "Free space soon — Operator needs room for model downloads and backups."}
        </p>
      </div>
    </div>
  );
}
