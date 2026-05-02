import { useMemo, useState } from "react";
import { Activity as ActivityIcon, Download, Search, X } from "lucide-react";
import { useListActivityEvents } from "@workspace/api-client-react";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { JsonView } from "@/components/operator/json-view";
import { getTenantId, getWorkspaceId } from "@/lib/api-config";
import { cn } from "@/lib/utils";

const EVENT_TYPES = [
  "all",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.invoked",
  "skill.executed",
  "approval.requested",
  "approval.decided",
  "system",
] as const;

const OUTCOME_STYLE: Record<string, string> = {
  success: "text-emerald-500",
  failure: "text-destructive",
  cancelled: "text-amber-500",
  pending: "text-sky-500",
};

export default function ActivityPage() {
  const [search, setSearch] = useState("");
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      limit: 100,
      ...(eventType !== "all" ? { eventType } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    }),
    [eventType, search],
  );

  const query = useListActivityEvents(filters);
  const items = query.data?.data.items ?? [];

  const onExport = async () => {
    const params = new URLSearchParams();
    if (eventType !== "all") params.set("eventType", eventType);
    if (search.trim()) params.set("search", search.trim());
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    const url = `${base}/api/activity/export.csv${params.toString() ? `?${params}` : ""}`;
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "X-Tenant-ID": getTenantId(),
        "X-Workspace-ID": getWorkspaceId(),
      },
    });
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `omninity-activity-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
  };

  return (
    <OperatorLayout
      title="Activity"
      description="Chronological feed of every run, skill, tool call and approval."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          data-testid="button-export-activity"
        >
          <Download className="mr-1 h-3 w-3" />
          Export CSV
        </Button>
      }
    >
      <div className="space-y-4 p-6">
        <ErrorBanner error={query.error} />

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search summary, actor or event…"
              className="pl-8"
              data-testid="input-activity-search"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                data-testid="button-clear-search"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          <Select
            value={eventType}
            onValueChange={(v) => setEventType(v as (typeof EVENT_TYPES)[number])}
          >
            <SelectTrigger className="w-[200px]" data-testid="select-event-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t} value={t} data-testid={`option-${t}`}>
                  {t === "all" ? "All event types" : t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Feed</CardTitle>
            <CardDescription className="text-xs">
              {items.length} events · newest first · click a row to expand
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {items.length === 0 ? (
              <EmptyState
                icon={<ActivityIcon className="h-6 w-6" />}
                title="No activity yet"
                description="Run an agent or invoke a tool — events will stream here."
                className="m-6"
              />
            ) : (
              <ul className="divide-y divide-border">
                {items.map((e) => {
                  const open = expanded === e.id;
                  return (
                    <li key={e.id} data-testid={`activity-${e.id}`}>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : e.id)}
                        className="flex w-full items-start gap-3 p-3 text-left text-sm hover-elevate"
                        data-testid={`button-expand-${e.id}`}
                      >
                        <div className="flex w-28 shrink-0 flex-col gap-1">
                          <Badge
                            variant="outline"
                            className={cn(
                              "w-fit text-[10px]",
                              OUTCOME_STYLE[e.outcome],
                            )}
                          >
                            {e.outcome}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(e.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {e.eventType}
                          </p>
                          <p className="text-sm">{e.summary}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            <span className="font-medium">{e.actor}</span>
                            {e.agent ? <> · {e.agent}</> : null}
                            {e.skillName ? <> · {e.skillName}</> : null}
                            {e.durationMs !== null && e.durationMs !== undefined ? (
                              <> · {e.durationMs}ms</>
                            ) : null}
                          </p>
                        </div>
                      </button>
                      {open ? (
                        <div
                          className="border-t border-border bg-muted/30 px-4 py-3 text-xs"
                          data-testid={`detail-${e.id}`}
                        >
                          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                            <Detail label="ID" value={e.id} />
                            <Detail label="Run" value={e.runId} />
                            <Detail label="Tool call" value={e.toolCallId} />
                            <Detail label="Approval" value={e.approvalId} />
                          </dl>
                          {e.metadata ? (
                            <div className="mt-3">
                              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                Metadata
                              </p>
                              <JsonView value={e.metadata} />
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </OperatorLayout>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground">{value ?? "—"}</dd>
    </>
  );
}
