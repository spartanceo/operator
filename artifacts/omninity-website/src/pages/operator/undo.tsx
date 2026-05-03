import { useMemo, useState } from "react";
import { Undo2, History, AlertTriangle, CheckCircle2, XCircle, Clock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUndoActions,
  useListUndoActionTypes,
  useUndoAction,
  getListUndoActionsQueryKey,
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
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  available: { label: "Available", className: "text-sky-500", icon: Clock },
  undone: { label: "Undone", className: "text-emerald-500", icon: CheckCircle2 },
  failed: { label: "Failed", className: "text-destructive", icon: XCircle },
  expired: { label: "Expired", className: "text-muted-foreground", icon: Clock },
  irreversible: {
    label: "Irreversible",
    className: "text-amber-500",
    icon: AlertTriangle,
  },
};

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function UndoPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const list = useListUndoActions({ limit: 100 });
  const types = useListUndoActionTypes();
  const undo = useUndoAction();

  const items = list.data?.data.items ?? [];
  const irreversible = useMemo(
    () => new Set(types.data?.data.irreversible ?? []),
    [types.data],
  );

  const handleUndo = async (id: string, label: string) => {
    if (!window.confirm(`Undo "${label}"? This cannot be re-done.`)) return;
    setError(null);
    try {
      await undo.mutateAsync({ id });
      await qc.invalidateQueries({ queryKey: getListUndoActionsQueryKey() });
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message ??
        (e instanceof Error ? e.message : String(e));
      setError(msg);
    }
  };

  return (
    <OperatorLayout title="Undo" description="Reverse recent desktop and file actions">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6" data-testid="undo-page">
        {error ? <ErrorBanner error={error} /> : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" aria-hidden />
              Action history
            </CardTitle>
            <CardDescription>
              Reversible actions you or an agent ran in the last 24 hours. Some
              actions (sending email, terminal commands, purchases) cannot be
              undone — they appear here for the audit trail only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {list.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : items.length === 0 ? (
              <EmptyState
                icon={<Undo2 className="h-6 w-6" />}
                title="Nothing to undo"
                description="Reversible actions will appear here as soon as Operator runs them."
              />
            ) : (
              <ul className="space-y-2">
                {items.map((a: any) => {
                  const meta = STATUS_STYLE[a.status] ?? STATUS_STYLE.available;
                  const Icon = meta.icon;
                  const isIrreversible =
                    !a.reversible || irreversible.has(a.actionType);
                  return (
                    <li
                      key={a.id}
                      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                      data-testid={`undo-row-${a.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Icon
                            className={cn("h-4 w-4 shrink-0", meta.className)}
                            aria-hidden
                          />
                          <span className="truncate text-sm font-medium">
                            {a.description || a.actionType}
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {a.actionType}
                          </Badge>
                          {isIrreversible ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 text-xs text-amber-500"
                            >
                              irreversible
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatTime(a.createdAt)} · {meta.label}
                          {a.error ? ` · ${a.error}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            isIrreversible ||
                            a.status !== "available" ||
                            undo.isPending
                          }
                          onClick={() =>
                            handleUndo(a.id, a.description || a.actionType)
                          }
                          data-testid={`undo-btn-${a.id}`}
                        >
                          <Undo2 className="mr-1 h-3 w-3" aria-hidden />
                          Undo
                        </Button>
                      </div>
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
