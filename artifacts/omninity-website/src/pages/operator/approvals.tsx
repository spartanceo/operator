import { useMemo, useState } from "react";
import { CheckCircle, ShieldAlert, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAgentApprovals,
  useBatchDecideApprovals,
  getListAgentApprovalsQueryKey,
} from "@workspace/api-client-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { cn } from "@/lib/utils";

const DECISION_STYLE: Record<string, string> = {
  pending: "text-amber-500",
  approved: "text-emerald-500",
  denied: "text-destructive",
};

export default function ApprovalsPage() {
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const qc = useQueryClient();
  const pendingQuery = useListAgentApprovals({
    decision: "pending",
    limit: 100,
  });
  const historyQuery = useListAgentApprovals(
    { limit: 100 },
    { query: { enabled: tab === "history" } as never },
  );
  const batch = useBatchDecideApprovals();

  const pending = pendingQuery.data?.data.items ?? [];
  const history = historyQuery.data?.data.items ?? [];

  const allSelected = useMemo(
    () => pending.length > 0 && pending.every((a) => selected.has(a.id)),
    [pending, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(pending.map((a) => a.id)));

  const decide = async (decision: "approved" | "denied") => {
    if (selected.size === 0) return;
    if (
      !window.confirm(
        `${decision === "approved" ? "Approve" : "Deny"} ${selected.size} request${selected.size === 1 ? "" : "s"}?`,
      )
    )
      return;
    await batch.mutateAsync({
      data: { ids: Array.from(selected), decision },
    });
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: getListAgentApprovalsQueryKey() });
  };

  return (
    <OperatorLayout
      title="Approvals"
      description="Review and decide every approval gate raised by your agents."
    >
      <div className="space-y-4 p-6">
        <ErrorBanner error={pendingQuery.error} />
        <ErrorBanner error={historyQuery.error} title="History failed" />
        <ErrorBanner error={batch.error} title="Batch decision failed" />

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="pending" data-testid="tab-pending">
              Pending
              {pending.length > 0 ? (
                <Badge variant="secondary" className="ml-2">
                  {pending.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="mt-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div>
                  <CardTitle className="text-base">Pending approvals</CardTitle>
                  <CardDescription className="text-xs">
                    {selected.size} of {pending.length} selected
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={toggleAll}
                    disabled={pending.length === 0}
                    data-testid="button-toggle-all"
                  >
                    {allSelected ? "Clear" : "Select all"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => decide("denied")}
                    disabled={selected.size === 0 || batch.isPending}
                    data-testid="button-batch-deny"
                  >
                    <XCircle className="mr-1 h-3 w-3" />
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => decide("approved")}
                    disabled={selected.size === 0 || batch.isPending}
                    data-testid="button-batch-approve"
                  >
                    <CheckCircle className="mr-1 h-3 w-3" />
                    Approve {selected.size > 0 ? `(${selected.size})` : ""}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {pending.length === 0 ? (
                  <EmptyState
                    icon={<ShieldAlert className="h-6 w-6" />}
                    title="No pending approvals"
                    description="When an agent requests a high-risk action, it will land here."
                    className="m-6"
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {pending.map((a) => {
                      const checked = selected.has(a.id);
                      return (
                        <li
                          key={a.id}
                          className={cn(
                            "flex items-start gap-3 p-3 text-sm",
                            checked && "bg-muted/40",
                          )}
                          data-testid={`approval-${a.id}`}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggle(a.id)}
                            className="mt-1"
                            data-testid={`checkbox-${a.id}`}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="font-medium">{a.summary}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              <span className="font-mono">{a.toolCallId}</span>
                              <span className="mx-2">·</span>
                              <span>Run {a.runId}</span>
                            </p>
                            <p className="mt-1 text-xs text-foreground/80">
                              {a.reason}
                            </p>
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(a.createdAt).toLocaleString()}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">All approvals</CardTitle>
                <CardDescription className="text-xs">
                  Decisions are immutable for audit. {history.length} loaded.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {history.length === 0 ? (
                  <EmptyState
                    icon={<ShieldAlert className="h-6 w-6" />}
                    title="No approvals yet"
                    className="m-6"
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {history.map((a) => (
                      <li
                        key={a.id}
                        className="grid grid-cols-[110px_1fr_180px] gap-3 p-3 text-sm"
                        data-testid={`history-${a.id}`}
                      >
                        <Badge
                          variant="outline"
                          className={cn(
                            "w-fit capitalize",
                            DECISION_STYLE[a.decision],
                          )}
                        >
                          {a.decision}
                        </Badge>
                        <div className="min-w-0">
                          <p className="font-medium">{a.summary}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {a.reason}
                          </p>
                          {a.note ? (
                            <p className="mt-1 text-xs italic text-foreground/80">
                              “{a.note}”
                            </p>
                          ) : null}
                        </div>
                        <div className="text-right text-[10px] text-muted-foreground">
                          <p>
                            {a.decidedAt
                              ? new Date(a.decidedAt).toLocaleString()
                              : "—"}
                          </p>
                          {a.decidedBy ? <p>by {a.decidedBy}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </OperatorLayout>
  );
}
