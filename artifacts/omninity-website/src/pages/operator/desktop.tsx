/**
 * Desktop control page — live LAV cycle UI.
 *
 * Layout: a session creator + history panel on the left, the live screen
 * panel + step approval cards on the right. The Stop button is always
 * visible while a session is running so the user can halt it instantly —
 * Standard 14 says destructive controls are first-class, never hidden in
 * a menu.
 *
 * Approvals: each step that needs approval surfaces a Step Approval Card.
 * Clicking it opens the standard ApprovalModal — same modal the chat
 * page uses, so the audit + UX behaviour is identical.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Monitor,
  Send,
  Square,
  Sparkles,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Approval,
  type DesktopSession,
  type DesktopStep,
  useCreateDesktopSession,
  useExecuteDesktopStep,
  useGetDesktopFeature,
  useGetDesktopSession,
  useListAgentRunApprovals,
  useListDesktopSessions,
  useListDesktopSessionSteps,
  useStopDesktopSession,
} from "@workspace/api-client-react";

import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { ApprovalModal } from "@/components/operator/approval-modal";
import { ScreenPanel } from "@/components/operator/screen-panel";
import { DesktopStepCard } from "@/components/operator/desktop-step-card";
import { cn } from "@/lib/utils";

// tier-review: bounded — fixed 3-element status enum, never mutated.
const TERMINAL_SESSION_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
]);

const SESSION_STATUS_STYLES: Record<string, string> = {
  planning: "text-muted-foreground",
  awaiting_approval: "text-amber-500",
  running: "text-amber-500",
  completed: "text-emerald-500",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

export default function DesktopPage() {
  const qc = useQueryClient();
  const [goal, setGoal] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeApproval, setActiveApproval] = useState<Approval | null>(null);
  const [activeStep, setActiveStep] = useState<DesktopStep | null>(null);

  const featureQuery = useGetDesktopFeature();
  const feature = featureQuery.data?.data ?? null;
  const featureEnabled = feature?.enabled ?? false;

  const sessionsQuery = useListDesktopSessions({ limit: 20 });
  const sessions = sessionsQuery.data?.data.items ?? [];

  const createSession = useCreateDesktopSession({
    mutation: {
      onSuccess: (resp) => {
        setActiveSessionId(resp.data.id);
        void qc.invalidateQueries();
      },
    },
  });
  const stopSession = useStopDesktopSession({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });
  const executeStep = useExecuteDesktopStep({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const sessionQuery = useGetDesktopSession(
    activeSessionId ?? "",
    {
      query: {
        enabled: Boolean(activeSessionId),
        refetchInterval: () => {
          const s = sessionQuery.data?.data;
          if (!s) return 2000;
          return TERMINAL_SESSION_STATUSES.has(s.status) ? false : 2000;
        },
      } as never,
    },
  );
  const stepsQuery = useListDesktopSessionSteps(
    activeSessionId ?? "",
    { limit: 50 },
    {
      query: {
        enabled: Boolean(activeSessionId),
        refetchInterval: 2000,
      } as never,
    },
  );
  const approvalsQuery = useListAgentRunApprovals(
    activeSessionId ?? "",
    { limit: 50 },
    {
      query: {
        enabled: Boolean(activeSessionId),
        refetchInterval: 2000,
      } as never,
    },
  );

  const session = sessionQuery.data?.data ?? null;
  // Steps come back ordered by stepIndex DESC (cursor-stable); reorder for display.
  const steps = useMemo(
    () =>
      [...(stepsQuery.data?.data.items ?? [])].sort(
        (a, b) => a.stepIndex - b.stepIndex,
      ),
    [stepsQuery.data],
  );
  const approvals = approvalsQuery.data?.data.items ?? [];

  const pendingApproval = useMemo(
    () => approvals.find((a) => a.decision === "pending") ?? null,
    [approvals],
  );

  useEffect(() => {
    if (pendingApproval && !activeApproval) {
      const step = steps.find((s) => s.approvalId === pendingApproval.id) ?? null;
      setActiveApproval(pendingApproval);
      setActiveStep(step);
    }
  }, [pendingApproval, activeApproval, steps]);

  const submit = () => {
    const text = goal.trim();
    if (!text) return;
    createSession.mutate({ data: { goal: text, autoExecute: true } });
    setGoal("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onApprove = (step: DesktopStep) => {
    const approval = approvals.find((a) => a.id === step.approvalId);
    if (approval) {
      setActiveApproval(approval);
      setActiveStep(step);
    }
  };

  const headerActions = (
    <div className="flex items-center gap-3">
      {feature ? (
        <Badge
          variant="outline"
          className={cn(
            "uppercase",
            featureEnabled ? "text-emerald-500" : "text-amber-500",
          )}
          data-testid="desktop-feature-badge"
        >
          {feature.mode}
        </Badge>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setActiveSessionId(null)}
        data-testid="button-new-desktop-session"
      >
        <RefreshCw className="mr-1 h-3 w-3" />
        New
      </Button>
    </div>
  );

  const isRunning =
    session !== null && !TERMINAL_SESSION_STATUSES.has(session.status);

  return (
    <OperatorLayout
      title="Desktop control"
      description="Look → Act → Verify with semantic targeting. No coordinates, ever."
      actions={headerActions}
    >
      <div className="grid h-full grid-cols-1 lg:grid-cols-[320px_1fr]">
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-border bg-muted/20 p-4">
          {!featureEnabled && feature ? (
            <div
              role="alert"
              data-testid="feature-disabled-banner"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-500" aria-hidden="true" />
              <p className="text-foreground/90">{feature.reason}</p>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              New session
            </p>
            <Textarea
              data-testid="input-desktop-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder='e.g. "open the browser and click the new tab button"'
              className="min-h-[88px] resize-none"
              disabled={createSession.isPending}
            />
            <ErrorBanner
              error={createSession.error ?? null}
              className="text-xs"
            />
            <Button
              size="sm"
              onClick={submit}
              disabled={!goal.trim() || createSession.isPending}
              className="w-full"
              data-testid="button-start-desktop-session"
            >
              <Send className="mr-1 h-3 w-3" />
              Plan + run
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              History
            </p>
            <ul className="space-y-1" data-testid="desktop-history">
              {sessions.length === 0 ? (
                <li className="text-xs italic text-muted-foreground">
                  No sessions yet.
                </li>
              ) : (
                sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setActiveSessionId(s.id)}
                      data-testid={`history-row-${s.id}`}
                      className={cn(
                        "w-full rounded-md border border-border p-2 text-left",
                        "hover-elevate active-elevate-2",
                        activeSessionId === s.id && "border-primary/60",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] uppercase",
                            SESSION_STATUS_STYLES[s.status] ?? "",
                          )}
                        >
                          {s.status.replace(/_/g, " ")}
                        </Badge>
                        <span className="truncate text-xs text-foreground">
                          {s.goal}
                        </span>
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6">
          {!session ? (
            <EmptyState
              icon={<Monitor className="h-6 w-6" />}
              title="No active desktop session"
              description="Describe a goal on the left to plan and run a Look-Act-Verify cycle."
            />
          ) : (
            <>
              <Card className="border-card-border" data-testid={`session-card-${session.id}`}>
                <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span>Session</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "uppercase",
                          SESSION_STATUS_STYLES[session.status] ?? "",
                        )}
                        data-testid={`session-status-${session.status}`}
                      >
                        {session.status.replace(/_/g, " ")}
                      </Badge>
                    </CardTitle>
                    <p className="text-sm text-foreground">{session.goal}</p>
                  </div>
                  {isRunning ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => stopSession.mutate({ id: session.id })}
                      disabled={stopSession.isPending}
                      data-testid="button-stop-desktop-session"
                    >
                      <Square className="mr-1 h-3 w-3" />
                      Stop
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-2 pt-0 text-xs text-muted-foreground">
                  {session.summary ? <p>{session.summary}</p> : null}
                  {session.error ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                      {session.error}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Plan steps</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {steps.length === 0 ? (
                      <p className="text-xs italic text-muted-foreground">
                        Planner is generating steps…
                      </p>
                    ) : (
                      <ul className="space-y-2" data-testid="desktop-steps-list">
                        {steps.map((step) => (
                          <DesktopStepCard
                            key={step.id}
                            step={step}
                            onExecute={(id) => executeStep.mutate({ id })}
                            onApprove={onApprove}
                            isPending={executeStep.isPending}
                          />
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <ScreenPanel sessionId={session.id} />
              </div>
            </>
          )}

          {!featureEnabled && session ? (
            <p className="text-center text-xs italic text-muted-foreground">
              <Sparkles className="mr-1 inline h-3 w-3" /> Stub mode: actions
              are recorded for audit but not actually performed.
            </p>
          ) : null}
        </section>
      </div>

      <ApprovalModal
        approval={activeApproval}
        open={Boolean(activeApproval)}
        onOpenChange={(open) => {
          if (!open) {
            setActiveApproval(null);
            const step = activeStep;
            setActiveStep(null);
            if (step && step.id) {
              // After approval decision, re-run the step so it advances.
              setTimeout(() => executeStep.mutate({ id: step.id }), 100);
            }
          }
        }}
        {...(activeStep ? { riskLevel: activeStep.riskLevel } : {})}
        {...(activeStep ? { toolName: `desktop.${activeStep.actionType}` } : {})}
        {...(activeStep
          ? {
              inputPreview: JSON.stringify(
                {
                  target: activeStep.targetDescription,
                  inputValue: activeStep.inputValue,
                },
                null,
                2,
              ),
            }
          : {})}
      />
    </OperatorLayout>
  );
}

// `DesktopSession` re-exported for downstream component typing in tests.
export type { DesktopSession };
