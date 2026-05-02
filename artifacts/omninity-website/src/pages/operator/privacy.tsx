import { useMemo } from "react";
import { Shield, Download, Trash2 } from "lucide-react";
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
import {
  useListPrivacyEvents,
  useExportTenantData,
  useEraseTenantData,
} from "@workspace/api-client-react";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { JsonView } from "@/components/operator/json-view";
import { HelpIcon } from "@/components/help";
import { cn } from "@/lib/utils";

const SEVERITY_STYLES: Record<string, string> = {
  info: "text-muted-foreground",
  notice: "text-sky-500",
  warning: "text-amber-500",
  alert: "text-destructive",
  critical: "text-destructive",
};

export default function PrivacyPage() {
  const eventsQuery = useListPrivacyEvents({ limit: 100 });
  const exportQuery = useExportTenantData({
    query: { enabled: false, retry: false } as never,
  });
  const erase = useEraseTenantData();

  const events = eventsQuery.data?.data.items ?? [];

  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) {
      const sev = e.severity || "info";
      counts[sev] = (counts[sev] ?? 0) + 1;
    }
    return counts;
  }, [events]);

  const onExport = async () => {
    const result = await exportQuery.refetch();
    if (result.data) {
      const blob = new Blob([JSON.stringify(result.data.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `omninity-tenant-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const onErase = () => {
    const confirmed = window.confirm(
      "Erase all data for this tenant? This is irreversible.",
    );
    if (!confirmed) return;
    erase.mutate(undefined);
  };

  return (
    <OperatorLayout
      title="Privacy"
      description="Audit log of every privacy-sensitive event. Export or erase all tenant data on demand (GDPR)."
      actions={
        <div className="flex items-center gap-2">
          <HelpIcon articleId="data-export" label="Export and erase" />
          <Button
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={exportQuery.isFetching}
            data-testid="button-export-data"
          >
            <Download className="mr-1 h-3 w-3" />
            {exportQuery.isFetching ? "Exporting…" : "Export"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onErase}
            disabled={erase.isPending}
            data-testid="button-erase-data"
          >
            <Trash2 className="mr-1 h-3 w-3" />
            {erase.isPending ? "Erasing…" : "Erase tenant"}
          </Button>
        </div>
      }
    >
      <div className="space-y-6 p-6">
        <ErrorBanner error={eventsQuery.error} />
        <ErrorBanner error={exportQuery.error} title="Export failed" />
        <ErrorBanner error={erase.error} title="Erase failed" />

        {erase.data ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Erasure receipt</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonView value={erase.data.data} />
            </CardContent>
          </Card>
        ) : null}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["info", "notice", "warning", "alert"] as const).map((sev) => (
            <Card key={sev} data-testid={`stat-${sev}`}>
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {sev}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-2xl font-semibold",
                      SEVERITY_STYLES[sev],
                    )}
                  >
                    {stats[sev] ?? 0}
                  </p>
                </div>
                <Shield className="h-6 w-6 text-muted-foreground/50" />
              </CardContent>
            </Card>
          ))}
        </section>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Event log</CardTitle>
              <CardDescription className="text-xs">
                Newest first. {events.length} events loaded.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {events.length === 0 ? (
              <EmptyState
                icon={<Shield className="h-6 w-6" />}
                title="No privacy events recorded yet"
                description="Tools that touch the file system or network will write events here."
                className="m-6"
              />
            ) : (
              <ul className="divide-y divide-border">
                {events.map((event) => (
                  <li
                    key={event.id}
                    className="grid grid-cols-[120px_1fr] gap-3 p-4 text-sm"
                    data-testid={`privacy-event-${event.id}`}
                  >
                    <div className="flex flex-col gap-1">
                      <Badge
                        variant="outline"
                        className={cn(
                          "w-fit uppercase",
                          SEVERITY_STYLES[event.severity] ?? "",
                        )}
                      >
                        {event.severity}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(event.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-foreground">
                        {event.eventType}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-medium">{event.actor}</span>
                        <span className="mx-1">→</span>
                        <span>{event.target}</span>
                      </p>
                      {event.detail ? (
                        <p className="mt-1 truncate text-xs text-foreground/80">
                          {event.detail}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </OperatorLayout>
  );
}
