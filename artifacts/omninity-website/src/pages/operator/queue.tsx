import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ListTodo,
  Loader2,
  Play,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  getGetQueueSnapshotQueryKey,
  useCancelQueuedTask,
  useClearQueuedTasks,
  useEnqueueTask,
  useGetQueueSnapshot,
  useSetQueuedTaskPriority,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
type QueuedTask = any;
type QueuedTaskPriority = "high" | "normal" | "low";

const PRIORITY_LABEL: Record<QueuedTaskPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};

function formatWait(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

const STATUS_BADGE: Record<string, string> = {
  queued: "border-sky-500/40 text-sky-500",
  running: "border-emerald-500/40 text-emerald-500",
  completed: "border-emerald-500/40 text-emerald-500",
  failed: "border-destructive/60 text-destructive",
  cancelled: "border-muted-foreground/40 text-muted-foreground",
  stale: "border-amber-500/60 text-amber-500",
};

export default function QueuePage() {
  const qc = useQueryClient();
  const snapshot = useGetQueueSnapshot({
    query: { refetchInterval: 2000 } as never,
  });
  const enqueue = useEnqueueTask();
  const cancel = useCancelQueuedTask();
  const setPriority = useSetQueuedTaskPriority();
  const clearAll = useClearQueuedTasks();

  const [goal, setGoal] = useState("");
  const [priority, setPriorityInput] = useState<QueuedTaskPriority>("normal");
  const [requiredFiles, setRequiredFiles] = useState("");

  const data = snapshot.data?.data as any;
  const refresh = () =>
    qc.invalidateQueries({ queryKey: getGetQueueSnapshotQueryKey() });

  const onEnqueue = async () => {
    if (!goal.trim()) return;
    const files = requiredFiles
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await enqueue.mutateAsync({
      data: {
        goal: goal.trim(),
        priority,
        ...(files.length
          ? { contextSnapshot: { requiredFiles: files } }
          : {}),
      },
    });
    setGoal("");
    setRequiredFiles("");
    setPriorityInput("normal");
    refresh();
  };

  const onCancel = async (id: string) => {
    await cancel.mutateAsync({ id });
    refresh();
  };

  const onBump = async (task: QueuedTask, dir: "up" | "down") => {
    const next: QueuedTaskPriority =
      dir === "up"
        ? task.priority === "low"
          ? "normal"
          : "high"
        : task.priority === "high"
          ? "normal"
          : "low";
    await setPriority.mutateAsync({ id: task.id, data: { priority: next } });
    refresh();
  };

  const onClear = async () => {
    await clearAll.mutateAsync({ data: { confirm: true } });
    refresh();
  };

  return (
    <OperatorLayout
      title="Tasks"
      description="Queue work, watch parallel runs, and bump priority — the queue runner serializes model access automatically."
      actions={
        data ? (
          <Badge variant="outline" data-testid="badge-queue-mode">
            {data.mode} · {data.parallelism} slot
            {data.parallelism === 1 ? "" : "s"}
          </Badge>
        ) : null
      }
    >
      <div className="space-y-4 p-6">
        <ErrorBanner error={snapshot.error || enqueue.error || cancel.error} />

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Enqueue task</CardTitle>
            <CardDescription className="text-xs">
              Tasks run as soon as a slot opens. Use stale-context files (comma
              separated) to skip the run if any are missing at pickup.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What should the agent do next?"
              data-testid="input-task-goal"
              rows={2}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={priority}
                onValueChange={(v) => setPriorityInput(v as QueuedTaskPriority)}
              >
                <SelectTrigger className="w-[160px]" data-testid="select-task-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["high", "normal", "low"] as const).map((p) => (
                    <SelectItem key={p} value={p} data-testid={`option-priority-${p}`}>
                      {PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={requiredFiles}
                onChange={(e) => setRequiredFiles(e.target.value)}
                placeholder="Required files (optional)"
                className="flex-1 min-w-[200px]"
                data-testid="input-required-files"
              />
              <Button
                onClick={onEnqueue}
                disabled={!goal.trim() || enqueue.isPending}
                data-testid="button-enqueue"
              >
                {enqueue.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-3 w-3" />
                )}
                Enqueue
              </Button>
            </div>
          </CardContent>
        </Card>

        <TaskSection
          title="Active"
          icon={<Play className="h-4 w-4" />}
          empty="No tasks running."
          tasks={data?.active ?? []}
          renderActions={(t) => (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCancel(t.id)}
              data-testid={`button-cancel-${t.id}`}
            >
              <XCircle className="h-3 w-3" />
            </Button>
          )}
        />

        <TaskSection
          title="Queued"
          icon={<ListTodo className="h-4 w-4" />}
          empty="Nothing waiting — enqueue something above."
          tasks={data?.queued ?? []}
          headerActions={
            (data?.queued?.length ?? 0) > 0 ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="button-clear-queue"
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    Clear all
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear queue?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This cancels every queued task. Active runs continue until
                      they finish on their own.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel data-testid="button-clear-cancel">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={onClear}
                      data-testid="button-clear-confirm"
                    >
                      Clear queue
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null
          }
          renderActions={(t) => (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onBump(t, "up")}
                disabled={t.priority === "high"}
                data-testid={`button-bump-up-${t.id}`}
                aria-label="Bump priority up"
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onBump(t, "down")}
                disabled={t.priority === "low"}
                data-testid={`button-bump-down-${t.id}`}
                aria-label="Bump priority down"
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onCancel(t.id)}
                data-testid={`button-cancel-${t.id}`}
              >
                <XCircle className="h-3 w-3" />
              </Button>
            </div>
          )}
        />

        <TaskSection
          title="Recent"
          icon={<CheckCircle2 className="h-4 w-4" />}
          empty="Completed tasks will appear here."
          tasks={data?.recent ?? []}
        />
      </div>
    </OperatorLayout>
  );
}

interface TaskSectionProps {
  title: string;
  icon: React.ReactNode;
  empty: string;
  tasks: ReadonlyArray<QueuedTask>;
  headerActions?: React.ReactNode;
  renderActions?: (t: QueuedTask) => React.ReactNode;
}

function TaskSection({
  title,
  icon,
  empty,
  tasks,
  headerActions,
  renderActions,
}: TaskSectionProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
            <Badge variant="outline" className="ml-1 text-[10px]">
              {tasks.length}
            </Badge>
          </CardTitle>
        </div>
        {headerActions}
      </CardHeader>
      <CardContent className="p-0">
        {tasks.length === 0 ? (
          <EmptyState
            icon={icon}
            title={title}
            description={empty}
            className="m-6"
          />
        ) : (
          <ul className="divide-y divide-border">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="flex items-start gap-3 p-3"
                data-testid={`task-${t.id}`}
              >
                <div className="flex w-24 shrink-0 flex-col gap-1">
                  <Badge
                    variant="outline"
                    className={`w-fit text-[10px] ${STATUS_BADGE[t.status] ?? ""}`}
                    data-testid={`status-${t.id}`}
                  >
                    {t.status}
                  </Badge>
                  <Badge variant="secondary" className="w-fit text-[10px]">
                    {PRIORITY_LABEL[t.priority as QueuedTaskPriority]}
                  </Badge>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm">{t.goal}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {new Date(t.createdAt).toLocaleString()}
                    {t.position !== null && t.position !== undefined ? (
                      <> · #{t.position + 1} in line</>
                    ) : null}
                    {t.estimatedWaitMs !== null &&
                    t.estimatedWaitMs !== undefined ? (
                      <span data-testid={`wait-${t.id}`}>
                        {" "}
                        · ~{formatWait(t.estimatedWaitMs)} wait
                      </span>
                    ) : null}
                    {t.runId ? <> · run {t.runId.slice(0, 8)}</> : null}
                  </p>
                  {t.staleReason ? (
                    <p
                      className="mt-1 text-xs text-amber-500"
                      data-testid={`stale-${t.id}`}
                    >
                      Stale: {t.staleReason}
                    </p>
                  ) : null}
                  {t.error ? (
                    <p className="mt-1 text-xs text-destructive">{t.error}</p>
                  ) : null}
                  {t.summary ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t.summary}
                    </p>
                  ) : null}
                </div>
                {renderActions ? renderActions(t) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
