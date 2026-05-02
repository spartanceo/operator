/**
 * DiagnosticsPanel — recent error log surfaced inside the operator shell.
 *
 * Implements the "Errors logged locally in detail for diagnostic purposes —
 * accessible via the help panel" requirement of Task #31. Reads from
 * /api/diagnostics/errors and renders newest-first. Each row carries the
 * plain-English message + suggested action plus an expandable technical
 * snippet for support diagnostics.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Trash2, RefreshCw } from "lucide-react";
import {
  useListDiagnosticErrors,
  useClearDiagnosticErrors,
  getListDiagnosticErrorsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorBanner } from "./error-banner";
import { EmptyState } from "./empty-state";
import { cn } from "@/lib/utils";

const SEVERITY_BADGE: Record<string, string> = {
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
  warning:
    "bg-amber-500/10 text-amber-800 dark:text-amber-200 border-amber-500/30",
  error: "bg-destructive/10 text-destructive border-destructive/30",
  critical: "bg-destructive/20 text-destructive border-destructive",
};

export function DiagnosticsPanel() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useListDiagnosticErrors(
    { limit: 50 },
    { query: { retry: false, refetchInterval: 30_000 } as never },
  );
  const clear = useClearDiagnosticErrors();

  const items = query.data?.data.items ?? [];

  const onRefresh = () => {
    void qc.invalidateQueries({
      queryKey: getListDiagnosticErrorsQueryKey({ limit: 50 }),
    });
  };

  const onClear = async () => {
    if (!window.confirm("Clear the diagnostic log? This cannot be undone.")) return;
    await clear.mutateAsync();
    void qc.invalidateQueries({ queryKey: getListDiagnosticErrorsQueryKey() });
  };

  return (
    <Card data-testid="diagnostics-panel">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-sm">Recent problems</CardTitle>
          <CardDescription className="text-xs">
            The last 50 errors Operator caught on this device. Plain-English
            explanations plus a technical snippet for support.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onRefresh}
            data-testid="button-refresh-diagnostics"
            title="Refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onClear}
            disabled={clear.isPending || items.length === 0}
            data-testid="button-clear-diagnostics"
            title="Clear log"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {query.isError ? (
          <ErrorBanner error={query.error} title="Couldn't load diagnostics" />
        ) : null}
        {query.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState
            title="No problems recorded"
            description="When Operator hits a problem, the details will appear here for you and for support."
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((entry) => {
              const isOpen = expanded === entry.id;
              return (
                <li
                  key={entry.id}
                  className="px-3 py-2 text-sm"
                  data-testid={`diagnostic-row-${entry.id}`}
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : entry.id)}
                    className="flex w-full items-start gap-2 text-left"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-5 px-1.5 text-[10px] capitalize",
                            SEVERITY_BADGE[entry.severity],
                          )}
                        >
                          {entry.severity}
                        </Badge>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {entry.code}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatTime(entry.timestamp)}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-medium">{entry.message}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry.action}
                      </p>
                    </div>
                  </button>
                  {isOpen ? (
                    <dl className="mt-2 ml-5 space-y-1 rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
                      <Row
                        label="HTTP status"
                        value={String(entry.httpStatus)}
                      />
                      {entry.method || entry.path ? (
                        <Row
                          label="Request"
                          value={`${entry.method ?? "?"} ${entry.path ?? ""}`.trim()}
                        />
                      ) : null}
                      {entry.requestId ? (
                        <Row label="Request ID" value={entry.requestId} mono />
                      ) : null}
                      {entry.causeSnippet ? (
                        <div>
                          <dt className="font-semibold uppercase tracking-wider">
                            Technical detail
                          </dt>
                          <dd className="mt-0.5 break-words font-mono text-[10px]">
                            {entry.causeSnippet}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 font-semibold uppercase tracking-wider">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-[10px]")}>
        {value}
      </dd>
    </div>
  );
}

function formatTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}
