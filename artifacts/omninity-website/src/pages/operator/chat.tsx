import { useEffect, useMemo, useRef, useState } from "react";
import {
  useChat,
  useCreateAgentRun,
  useGetAgentRun,
  useListAgentRunMessages,
  useListAgentRunToolCalls,
  useListAgentRunApprovals,
  useCancelAgentRun,
  useListModels,
  useGetOnboardingProfile,
  useUpsertOnboardingProfile,
  type ChatMessage,
  type Approval,
  type Message,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Send, Square, RefreshCw, Sparkles } from "lucide-react";
import { OperatorLayout } from "@/components/operator/layout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { PlanCard } from "@/components/operator/plan-card";
import { ApprovalModal } from "@/components/operator/approval-modal";
import { ExecutionTimeline } from "@/components/operator/timeline";
import { StarterChips } from "@/components/onboarding/starter-chips";
import { SuccessSparkle } from "@/components/onboarding/success-sparkle";
import {
  HelpIcon,
  InlineHints,
  FirstTimeTooltip,
  useHelp,
} from "@/components/help";
import { useSettings } from "@/contexts/settings-context";
import { cn } from "@/lib/utils";

// tier-review: bounded — fixed status enum, never mutated at runtime
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
// Only celebrate successful runs — failed / cancelled runs should not flip
// the first-task flag, otherwise a user whose very first attempt errored
// would never see the welcome animation on their next attempt.
// tier-review: bounded — single-element status enum
const COMPLETED_STATUSES = new Set(["succeeded"]);

interface LocalChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
}

export default function ChatPage() {
  const { settings } = useSettings();
  const qc = useQueryClient();
  const { completeChecklistItem } = useHelp();
  const [agentMode, setAgentMode] = useState(false);
  const [input, setInput] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeApproval, setActiveApproval] = useState<Approval | null>(null);
  const [chatTurns, setChatTurns] = useState<LocalChatTurn[]>([]);
  const [model, setModel] = useState<string>(settings.defaultModel);
  const [showSparkle, setShowSparkle] = useState(false);
  const sparkleFiredFor = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const profileQuery = useGetOnboardingProfile();
  const profile = profileQuery.data?.data.profile ?? null;
  const showFirstApprovalTooltip = profile?.approvalTooltipSeen === false;
  const firstTaskCompleted = profile?.firstTaskCompleted === true;
  const markFirstTask = useUpsertOnboardingProfile({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const modelsQuery = useListModels();
  const availableModels = modelsQuery.data?.data.items ?? [];

  useEffect(() => {
    if (!modelsQuery.data) return;
    const items = modelsQuery.data.data.items;
    if (items.length === 0) return;
    const exists = items.some((m) => m.name === model);
    if (!exists) {
      setModel(items[0]!.name);
    }
  }, [modelsQuery.data, model]);

  const chatMutation = useChat({
    mutation: {
      onSuccess: (resp, vars) => {
        const last = vars.data.messages[vars.data.messages.length - 1];
        const userTurn: LocalChatTurn = {
          id: `u-${Date.now()}`,
          role: "user",
          content: last?.content ?? "",
        };
        const asst: LocalChatTurn = {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: resp.data.message.content,
          model: resp.data.model,
        };
        setChatTurns((curr) => [...curr, userTurn, asst]);
      },
    },
  });

  const createRun = useCreateAgentRun({
    mutation: {
      onSuccess: (resp) => {
        setActiveRunId(resp.data.id);
        void qc.invalidateQueries();
      },
    },
  });

  const cancelRun = useCancelAgentRun({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const runQuery = useGetAgentRun(activeRunId ?? "", {
    query: {
      enabled: Boolean(activeRunId),
      refetchInterval: (query: { state: { data?: { data?: { status: string } } } }) => {
        const data = query.state.data;
        if (!data?.data) return 2000;
        return TERMINAL_STATUSES.has(data.data.status) ? false : 2000;
      },
    } as never,
  });

  const messagesQuery = useListAgentRunMessages(
    activeRunId ?? "",
    { limit: 100 },
    {
      query: {
        enabled: Boolean(activeRunId),
        refetchInterval: () => {
          const run = runQuery.data?.data;
          if (!run) return 2000;
          return TERMINAL_STATUSES.has(run.status) ? false : 2000;
        },
      } as never,
    },
  );

  const toolCallsQuery = useListAgentRunToolCalls(
    activeRunId ?? "",
    { limit: 100 },
    {
      query: {
        enabled: Boolean(activeRunId),
        refetchInterval: () => {
          const run = runQuery.data?.data;
          if (!run) return 2000;
          return TERMINAL_STATUSES.has(run.status) ? false : 2000;
        },
      } as never,
    },
  );

  const approvalsQuery = useListAgentRunApprovals(
    activeRunId ?? "",
    { limit: 50 },
    {
      query: {
        enabled: Boolean(activeRunId),
        refetchInterval: () => {
          const run = runQuery.data?.data;
          if (!run) return 2000;
          return TERMINAL_STATUSES.has(run.status) ? false : 2000;
        },
      } as never,
    },
  );

  const run = runQuery.data?.data ?? null;
  const runMessages = messagesQuery.data?.data.items ?? [];
  const toolCalls = toolCallsQuery.data?.data.items ?? [];
  const approvals = approvalsQuery.data?.data.items ?? [];

  const pendingApproval = useMemo(
    () => approvals.find((a) => a.decision === "pending") ?? null,
    [approvals],
  );

  useEffect(() => {
    if (pendingApproval && !activeApproval) {
      setActiveApproval(pendingApproval);
    }
  }, [pendingApproval, activeApproval]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatTurns.length, runMessages.length]);

  // Fire the success sparkle exactly once when the user's first agent run
  // reaches a completed state. The ref guard keeps the toast from re-firing
  // while the run query is still polling its terminal payload, and the
  // server's monotonic `firstTaskCompleted` flag prevents replays across
  // sessions even if the local ref is reset by a refresh.
  useEffect(() => {
    if (!run || !activeRunId) return;
    if (firstTaskCompleted) return;
    if (!COMPLETED_STATUSES.has(run.status)) return;
    if (sparkleFiredFor.current === activeRunId) return;
    sparkleFiredFor.current = activeRunId;
    setShowSparkle(true);
    markFirstTask.mutate({ data: { firstTaskCompleted: true } });
  }, [run, activeRunId, firstTaskCompleted, markFirstTask]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    completeChecklistItem("first-chat");
    if (agentMode) {
      completeChecklistItem("agent-run");
      createRun.mutate({
        data: { goal: text, ...(model ? { modelName: model } : {}) },
      });
      setInput("");
    } else {
      const newMessages: ChatMessage[] = [
        ...chatTurns.map<ChatMessage>((t) => ({
          role: t.role,
          content: t.content,
        })),
        { role: "user", content: text },
      ];
      chatMutation.mutate({
        data: {
          messages: newMessages,
          ...(model ? { model } : {}),
        },
      });
      setInput("");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const newConversation = () => {
    setChatTurns([]);
    setActiveRunId(null);
    setActiveApproval(null);
  };

  const headerActions = (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <FirstTimeTooltip
          id="chat-agent-toggle"
          title="Try Agent mode"
          body="Flip this switch to plan, execute and verify a multi-step goal end-to-end."
          side="bottom"
        >
          <div className="flex items-center gap-2">
            <Switch
              id="agent-mode"
              checked={agentMode}
              onCheckedChange={setAgentMode}
              data-testid="switch-agent-mode"
            />
            <label
              htmlFor="agent-mode"
              className="cursor-pointer select-none text-sm text-muted-foreground"
            >
              Agent
            </label>
          </div>
        </FirstTimeTooltip>
        <HelpIcon articleId="approvals" label="Agent mode" />
      </div>
      <div className="hidden md:block w-48">
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger data-testid="select-model" className="h-8">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            {availableModels.length === 0 ? (
              <SelectItem value={settings.defaultModel} disabled>
                {settings.defaultModel} (no models)
              </SelectItem>
            ) : (
              availableModels.map((m) => (
                <SelectItem key={m.name} value={m.name}>
                  {m.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={newConversation}
        data-testid="button-new-conversation"
      >
        <RefreshCw className="mr-1 h-3 w-3" />
        New
      </Button>
    </div>
  );

  return (
    <OperatorLayout
      title={agentMode ? "Agent run" : "Chat"}
      description={
        agentMode
          ? "Multi-agent execution with plans, tools, and approvals."
          : "Direct conversation with the local model."
      }
      actions={headerActions}
    >
      <div className="grid h-full grid-rows-[1fr_auto] lg:grid-cols-[1fr_360px]">
        <section className="flex min-h-0 flex-col overflow-hidden border-r border-border">
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {agentMode ? (
              <AgentTranscript
                runId={activeRunId}
                messages={runMessages}
                isLoading={messagesQuery.isLoading}
              />
            ) : (
              <ChatTranscript turns={chatTurns} />
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-border bg-background/95 px-6 py-4">
            <ErrorBanner error={chatMutation.error ?? createRun.error ?? null} className="mb-3" />
            {(agentMode ? !activeRunId : chatTurns.length === 0) ? (
              <div className="mb-3 space-y-3">
                <StarterChips onPick={(prompt) => setInput(prompt)} />
                <InlineHints onPick={(prompt) => setInput(prompt)} />
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <Textarea
                data-testid="input-chat"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  agentMode
                    ? "Describe a goal for the agent…"
                    : "Send a message…"
                }
                className="min-h-[72px] max-h-48 resize-none"
                disabled={chatMutation.isPending || createRun.isPending}
              />
              <div className="flex flex-col gap-2">
                {agentMode && activeRunId && run && !TERMINAL_STATUSES.has(run.status) ? (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => cancelRun.mutate({ id: activeRunId })}
                    disabled={cancelRun.isPending}
                    aria-label="Cancel run"
                    data-testid="button-cancel-run"
                  >
                    <Square className="h-4 w-4" />
                  </Button>
                ) : null}
                <Button
                  size="icon"
                  onClick={submit}
                  disabled={
                    !input.trim() || chatMutation.isPending || createRun.isPending
                  }
                  aria-label="Send"
                  data-testid="button-send"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </section>

        <aside className="hidden lg:flex flex-col gap-4 overflow-y-auto bg-muted/20 p-6">
          {agentMode && run ? (
            <>
              <PlanCard run={run} />
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Execution timeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <ExecutionTimeline calls={toolCalls} />
                </CardContent>
              </Card>
              {approvals.length > 0 ? (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Approvals</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {approvals.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={cn(
                          "w-full rounded-md border border-border p-2 text-left hover-elevate active-elevate-2",
                          a.decision === "pending" && "border-amber-500/40",
                        )}
                        onClick={() => setActiveApproval(a)}
                        data-testid={`approval-row-${a.id}`}
                      >
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="text-[10px] uppercase"
                          >
                            {a.decision}
                          </Badge>
                          <span className="truncate text-xs text-foreground">
                            {a.summary}
                          </span>
                        </div>
                      </button>
                    ))}
                  </CardContent>
                </Card>
              ) : null}
            </>
          ) : (
            <EmptyState
              icon={<Sparkles className="h-6 w-6" />}
              title={agentMode ? "No active run" : "Direct chat mode"}
              description={
                agentMode
                  ? "Send a goal to start a multi-agent run."
                  : "Toggle Agent mode to invoke planner, executor, and tools."
              }
            />
          )}
        </aside>
      </div>

      <ApprovalModal
        approval={activeApproval}
        open={Boolean(activeApproval)}
        onOpenChange={(open) => {
          if (!open) setActiveApproval(null);
        }}
        showFirstApprovalTooltip={showFirstApprovalTooltip}
        riskLevel={
          activeApproval
            ? toolCalls.find((c) => c.id === activeApproval.toolCallId)?.riskLevel
            : undefined
        }
        toolName={
          activeApproval
            ? toolCalls.find((c) => c.id === activeApproval.toolCallId)?.toolName
            : undefined
        }
        inputPreview={
          activeApproval
            ? toolCalls.find((c) => c.id === activeApproval.toolCallId)?.input
            : undefined
        }
      />

      <SuccessSparkle
        show={showSparkle}
        onDone={() => setShowSparkle(false)}
      />
    </OperatorLayout>
  );
}

function ChatTranscript({ turns }: { turns: LocalChatTurn[] }) {
  if (turns.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles className="h-6 w-6" />}
        title="Start a conversation"
        description="Ask anything. The model runs locally via Ollama."
      />
    );
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {turns.map((t) => (
        <div
          key={t.id}
          className={cn(
            "rounded-lg border border-border p-4",
            t.role === "user" ? "bg-card" : "bg-muted/40",
          )}
          data-testid={`chat-turn-${t.role}`}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t.role === "user" ? "You" : "Assistant"}
            </span>
            {t.model ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                {t.model}
              </span>
            ) : null}
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {t.content}
          </p>
        </div>
      ))}
    </div>
  );
}

function AgentTranscript({
  runId,
  messages,
  isLoading,
}: {
  runId: string | null;
  messages: Message[];
  isLoading: boolean;
}) {
  if (!runId) {
    return (
      <EmptyState
        icon={<Sparkles className="h-6 w-6" />}
        title="Start an agent run"
        description="Describe what you want done. Router → Planner → Executor → Verifier."
      />
    );
  }
  if (isLoading && messages.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">Loading run…</p>
    );
  }
  if (messages.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        Waiting for the agent to produce output…
      </p>
    );
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {messages.map((m) => (
        <div
          key={m.id}
          className={cn(
            "rounded-lg border border-border p-4",
            m.role === "user" ? "bg-card" : "bg-muted/40",
          )}
          data-testid={`agent-message-${m.role}`}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {m.role}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {new Date(m.createdAt).toLocaleTimeString()}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {m.content}
          </p>
        </div>
      ))}
    </div>
  );
}
