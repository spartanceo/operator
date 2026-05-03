import { useMemo, useState } from "react";
import {
  CalendarClock,
  Pause,
  Play,
  Plus,
  Trash2,
  Sparkles,
  CheckCircle2,
  XCircle,
  Clock,
  History,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateSchedule,
  useDeleteSchedule,
  useGetScheduleSettings,
  useListSchedules,
  usePauseSchedule,
  usePreviewSchedule,
  useRunScheduleNow,
  useUpdateScheduleSettings,
  getListSchedulesQueryKey,
  getGetScheduleSettingsQueryKey,
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";

function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function getApiError(e: unknown): string {
  return (
    (e as { response?: { data?: { error?: { message?: string } } } })?.response
      ?.data?.error?.message ??
    (e instanceof Error ? e.message : String(e))
  );
}

const STATUS_ICON: Record<string, { className: string; icon: typeof Clock }> = {
  succeeded: { className: "text-emerald-500", icon: CheckCircle2 },
  failed: { className: "text-destructive", icon: XCircle },
  cancelled: { className: "text-muted-foreground", icon: XCircle },
  running: { className: "text-sky-500", icon: Clock },
  pending: { className: "text-muted-foreground", icon: Clock },
};

export default function SchedulesPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [naturalLanguage, setNaturalLanguage] = useState("");
  const [cronExpression, setCronExpression] = useState("");

  const list = useListSchedules({ limit: 100 });
  const settings = useGetScheduleSettings();
  const create = useCreateSchedule();
  const del = useDeleteSchedule();
  const runNow = useRunScheduleNow();
  const pause = usePauseSchedule();
  const preview = usePreviewSchedule();
  const updateSettings = useUpdateScheduleSettings();

  const items = (((list.data?.data as any)?.items ?? []) as any[]);
  const tzOffset = useMemo(() => -new Date().getTimezoneOffset(), []);
  const globalPaused = (settings.data?.data as any)?.settings?.globalPaused ?? false;

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
    await qc.invalidateQueries({ queryKey: getGetScheduleSettingsQueryKey() });
  };

  const handlePreview = async () => {
    setError(null);
    try {
      await preview.mutateAsync({
        data: {
          ...(cronExpression ? { cronExpression } : {}),
          ...(naturalLanguage ? { naturalLanguage } : {}),
          tzOffsetMinutes: tzOffset,
        },
      });
    } catch (e) {
      setError(getApiError(e));
    }
  };

  const handleCreate = async () => {
    setError(null);
    if (!title.trim() || !prompt.trim()) {
      setError("Title and prompt are required.");
      return;
    }
    if (!cronExpression && !naturalLanguage) {
      setError("Provide a cron expression or a natural-language schedule.");
      return;
    }
    try {
      await create.mutateAsync({
        data: {
          title: title.trim(),
          prompt: prompt.trim(),
          ...(cronExpression ? { cronExpression } : {}),
          ...(naturalLanguage ? { naturalLanguage } : {}),
          tzOffsetMinutes: tzOffset,
        },
      });
      setTitle("");
      setPrompt("");
      setNaturalLanguage("");
      setCronExpression("");
      await invalidate();
    } catch (e) {
      setError(getApiError(e));
    }
  };

  const handleDelete = async (id: string, label: string) => {
    if (!window.confirm(`Delete schedule "${label}" and its history?`)) return;
    setError(null);
    try {
      await del.mutateAsync({ id });
      await invalidate();
    } catch (e) {
      setError(getApiError(e));
    }
  };

  const handleRunNow = async (id: string) => {
    setError(null);
    try {
      await runNow.mutateAsync({ id });
      await invalidate();
    } catch (e) {
      setError(getApiError(e));
    }
  };

  const handlePause = async (id: string, paused: boolean) => {
    setError(null);
    try {
      await pause.mutateAsync({ id, data: { paused } });
      await invalidate();
    } catch (e) {
      setError(getApiError(e));
    }
  };

  const handleGlobalPause = async (next: boolean) => {
    setError(null);
    try {
      await updateSettings.mutateAsync({ data: { globalPaused: next } });
      await invalidate();
    } catch (e) {
      setError(getApiError(e));
    }
  };

  const previewData = (preview.data?.data as any)?.preview;

  return (
    <OperatorLayout
      title="Scheduled Tasks"
      description="Run autonomous tasks on a recurring cron schedule"
    >
      <div
        className="mx-auto w-full max-w-5xl space-y-6 p-6"
        data-testid="schedules-page"
      >
        {error ? <ErrorBanner error={error} /> : null}

        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CalendarClock className="size-5" /> Scheduler
              </CardTitle>
              <CardDescription>
                {globalPaused
                  ? "All schedules are paused globally — toggle to resume."
                  : "All non-paused schedules will fire on their cadence."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label
                htmlFor="global-pause"
                className="text-sm text-muted-foreground"
              >
                Global pause
              </Label>
              <Switch
                id="global-pause"
                checked={globalPaused}
                onCheckedChange={handleGlobalPause}
                data-testid="global-pause-switch"
              />
            </div>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="size-5" /> New schedule
            </CardTitle>
            <CardDescription>
              Describe the cadence in plain English ("every weekday at 9am") or
              paste a 5-field cron expression.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="schedule-title">Title</Label>
              <Input
                id="schedule-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Daily standup digest"
                data-testid="input-title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-prompt">Task prompt</Label>
              <Textarea
                id="schedule-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Summarise today's calendar and email me the brief."
                rows={3}
                data-testid="input-prompt"
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="schedule-nl">Natural language</Label>
                <Input
                  id="schedule-nl"
                  value={naturalLanguage}
                  onChange={(e) => {
                    setNaturalLanguage(e.target.value);
                    if (e.target.value) setCronExpression("");
                  }}
                  placeholder="every weekday at 9am"
                  data-testid="input-natural"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="schedule-cron">Cron (optional)</Label>
                <Input
                  id="schedule-cron"
                  value={cronExpression}
                  onChange={(e) => {
                    setCronExpression(e.target.value);
                    if (e.target.value) setNaturalLanguage("");
                  }}
                  placeholder="0 9 * * 1-5"
                  data-testid="input-cron"
                />
              </div>
            </div>
            {previewData ? (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                <div className="font-medium">
                  Cron:{" "}
                  <code className="text-primary">
                    {previewData.cronExpression}
                  </code>{" "}
                  <Badge variant="secondary" className="ml-2">
                    {previewData.recurrenceKind}
                  </Badge>
                </div>
                <div className="mt-2 text-muted-foreground">
                  Next runs:
                  <ul className="ml-4 list-disc">
                    {previewData.nextRuns.map((iso: any) => (
                      <li key={iso}>{formatTime(iso)}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={handlePreview}
                disabled={
                  preview.isPending || (!cronExpression && !naturalLanguage)
                }
                data-testid="button-preview"
              >
                <Sparkles className="size-4" /> Preview
              </Button>
              <Button
                onClick={handleCreate}
                disabled={create.isPending}
                data-testid="button-create"
              >
                <Plus className="size-4" /> Create schedule
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-5" /> Active schedules
            </CardTitle>
            <CardDescription>
              {items.length === 0
                ? "No schedules yet."
                : `${items.length} schedule${items.length === 1 ? "" : "s"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <EmptyState
                icon={<CalendarClock className="size-6" />}
                title="No schedules yet"
                description="Create one above to run a task automatically on a cadence."
              />
            ) : (
              <ul className="space-y-3">
                {items.map((s: any) => {
                  const statusKey = s.lastRunStatus ?? "pending";
                  const Icon = STATUS_ICON[statusKey]?.icon ?? Clock;
                  const iconClass =
                    STATUS_ICON[statusKey]?.className ??
                    "text-muted-foreground";
                  return (
                    <li
                      key={s.id}
                      className="rounded-md border border-border p-4"
                      data-testid={`schedule-${s.id}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{s.title}</span>
                            <Badge variant="secondary">
                              {s.recurrenceKind}
                            </Badge>
                            {s.paused ? (
                              <Badge variant="outline">Paused</Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {s.prompt}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              Cron:{" "}
                              <code className="text-foreground">
                                {s.cronExpression}
                              </code>
                            </span>
                            <span>Next: {formatTime(s.nextRunAt)}</span>
                            <span className="flex items-center gap-1">
                              <Icon className={`size-3 ${iconClass}`} />
                              Last: {formatTime(s.lastRunAt)} ({statusKey})
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRunNow(s.id)}
                            disabled={runNow.isPending}
                            data-testid={`button-run-${s.id}`}
                          >
                            <Play className="size-4" /> Run now
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handlePause(s.id, !s.paused)}
                            disabled={pause.isPending}
                            data-testid={`button-pause-${s.id}`}
                          >
                            <Pause className="size-4" />{" "}
                            {s.paused ? "Resume" : "Pause"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(s.id, s.title)}
                            disabled={del.isPending}
                            data-testid={`button-delete-${s.id}`}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                      {s.lastRunSummary ? (
                        <>
                          <Separator className="my-3" />
                          <p className="text-xs text-muted-foreground">
                            {s.lastRunSummary}
                          </p>
                        </>
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
