import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useCreateConversation,
  useListConversationMessages,
  getListConversationMessagesQueryKey,
  getListConversationsQueryKey,
  getGetConversationContextQueryKey,
  useAppendConversationMessage,
  useListSkills,
  useTranscribeAudio,
  useSynthesizeSpeech,
  useGetConversationContext,
  useResetConversationContext,
  usePinConversationMessage,
  useUnpinConversationMessage,
  type ChatMessage,
  type Approval,
  type Message,
  type Conversation,
  type ConversationMessage,
  type ContextUsage,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Send, Square, RefreshCw, Sparkles, Bookmark, Pin, PinOff, Paperclip, X } from "lucide-react";
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
import { ConversationSidebar } from "@/components/operator/conversation-sidebar";
import { ContextUsageBar } from "@/components/operator/context-usage-bar";
import { QuickLaunchBar } from "@/components/operator/quick-launch-bar";
import { SaveTemplateDialog } from "@/components/operator/save-template-dialog";
import { StarterChips } from "@/components/onboarding/starter-chips";
import { SuccessSparkle } from "@/components/onboarding/success-sparkle";
import {
  MicButton,
  VoiceModeToggle,
  Waveform,
} from "@/components/operator/voice-controls";
import {
  HelpIcon,
  InlineHints,
  FirstTimeTooltip,
  useHelp,
} from "@/components/help";
import { useSettings } from "@/contexts/settings-context";
import { getTenantId, getWorkspaceId } from "@/lib/api-config";
import { cn } from "@/lib/utils";
import {
  useVoicePlayer,
  useVoiceRecorder,
  useWakeWord,
  type VoiceRecording,
} from "@/lib/voice-engine";

// tier-review: bounded — fixed status enum, never mutated at runtime
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
// tier-review: bounded — single-element status enum
const COMPLETED_STATUSES = new Set(["succeeded"]);

function getApiBase(): string {
  const win = window as Window &
    typeof globalThis & {
      electronAPI?: { getApiPort?: () => number | null };
    };
  const port = win.electronAPI?.getApiPort?.();
  return port ? `http://127.0.0.1:${port}` : "";
}

/**
 * Cold-start ready marker consumed by `e2e/startup-time.spec.ts`.
 * See chat.tsx history for full rationale — kept identical here.
 */
function ChatReadyMarker() {
  return <span data-test="chat-ready" hidden aria-hidden="true" />;
}

export default function ChatPage() {
  const { settings, update: updateSettings } = useSettings();
  const qc = useQueryClient();
  const { completeChecklistItem } = useHelp();
  const [agentMode, setAgentMode] = useState(false);
  const [input, setInput] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeApproval, setActiveApproval] = useState<Approval | null>(null);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [model, setModel] = useState<string>(settings.defaultModel);
  const [showSparkle, setShowSparkle] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [lastSentPrompt, setLastSentPrompt] = useState<string>("");
  const sparkleFiredFor = useRef<string | null>(null);
  const [skillId, setSkillId] = useState<string>("auto");
  const [activeRunSkillId, setActiveRunSkillId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const [attachedPdf, setAttachedPdf] = useState<{ name: string } | null>(null);
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);

  const profileQuery = useGetOnboardingProfile();
  const profile = profileQuery.data?.data.profile ?? null;
  const showFirstApprovalTooltip = profile?.approvalTooltipSeen === false;
  const firstTaskCompleted = profile?.firstTaskCompleted === true;
  const markFirstTask = useUpsertOnboardingProfile({
    mutation: { onSuccess: () => void qc.invalidateQueries() },
  });

  const modelsQuery = useListModels();
  const availableModels = modelsQuery.data?.data.items ?? [];

  const installedSkillsQuery = useListSkills(
    { installed: true, limit: 100 },
    { query: { enabled: agentMode } as never },
  );
  const installedSkills = installedSkillsQuery.data?.data.items ?? [];

  useEffect(() => {
    if (!modelsQuery.data) return;
    const items = modelsQuery.data.data.items;
    if (items.length === 0) return;
    const exists = items.some((m) => m.name === model);
    if (!exists) {
      setModel(items[0]!.name);
    }
  }, [modelsQuery.data, model]);

  // Conversation transcript (loaded when a thread is selected). Used in
  // both chat-mode and agent-mode: it gives us the full multi-turn history
  // restored across page reloads.
  const conversationMessagesQuery = useListConversationMessages(
    activeConversation?.id ?? "",
    { limit: 200 },
    {
      query: { enabled: Boolean(activeConversation) } as never,
    },
  );
  const conversationMessages =
    conversationMessagesQuery.data?.data.items ?? [];

  // Context-window usage indicator (Task #51). Polled while the user
  // is composing so the bar reflects pending input + new messages
  // shortly after they land. Disabled when no conversation is active.
  const contextQuery = useGetConversationContext(
    activeConversation?.id ?? "",
    {
      ...(model ? { model } : {}),
      ...(input.trim() ? { pendingInput: input } : {}),
    },
    {
      query: {
        enabled: Boolean(activeConversation),
        refetchInterval: 5000,
      } as never,
    },
  );
  const contextUsage: ContextUsage | null =
    (contextQuery.data?.data as ContextUsage | undefined) ?? null;

  const resetContext = useResetConversationContext({
    mutation: {
      onSuccess: () => {
        if (activeConversation) {
          void qc.invalidateQueries({
            queryKey: getGetConversationContextQueryKey(activeConversation.id),
          });
        }
      },
    },
  });
  const pinMessage = usePinConversationMessage({
    mutation: {
      onSuccess: () => {
        if (activeConversation) {
          void qc.invalidateQueries({
            queryKey: getListConversationMessagesQueryKey(activeConversation.id),
          });
          void qc.invalidateQueries({
            queryKey: getGetConversationContextQueryKey(activeConversation.id),
          });
        }
      },
    },
  });
  const unpinMessage = useUnpinConversationMessage({
    mutation: {
      onSuccess: () => {
        if (activeConversation) {
          void qc.invalidateQueries({
            queryKey: getListConversationMessagesQueryKey(activeConversation.id),
          });
          void qc.invalidateQueries({
            queryKey: getGetConversationContextQueryKey(activeConversation.id),
          });
        }
      },
    },
  });

  const createConversation = useCreateConversation({
    mutation: {
      onSuccess: (resp) => {
        setActiveConversation(resp.data);
        void qc.refetchQueries({
          queryKey: getListConversationsQueryKey(),
          exact: false,
        });
      },
    },
  });

  const appendMessage = useAppendConversationMessage({
    mutation: {
      onSuccess: (_data, vars) => {
        void qc.refetchQueries({
          queryKey: getListConversationsQueryKey(),
          exact: false,
        });
        void qc.refetchQueries({
          queryKey: getListConversationMessagesQueryKey(vars.id),
          exact: false,
        });
      },
    },
  });

  // Ensure a conversation exists; creates one lazily on first send so the
  // sidebar never shows empty stub threads.
  const ensureConversation = async (
    seedTitle: string,
  ): Promise<Conversation> => {
    if (activeConversation) return activeConversation;
    const result = await createConversation.mutateAsync({
      data: {
        title: seedTitle.slice(0, 80),
        agentMode,
        ...(model ? { modelName: model } : {}),
      },
    });
    return result.data;
  };

  const handlePdfSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!e.target) return;
      (e.target as HTMLInputElement).value = "";
      if (!file) return;
      setPdfError(null);
      setPdfUploading(true);
      try {
        const conversation = await ensureConversation(
          file.name.replace(/\.pdf$/i, "").slice(0, 80),
        );
        const form = new FormData();
        form.append("file", file);
        const base = getApiBase();
        const resp = await fetch(
          `${base}/api/conversations/${conversation.id}/attachments`,
          {
            method: "POST",
            headers: {
              "X-Tenant-ID": getTenantId(),
              "X-Workspace-ID": getWorkspaceId(),
            },
            body: form,
          },
        );
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(body?.error?.message ?? "Upload failed");
        }
        setAttachedPdf({ name: file.name });
        void qc.refetchQueries({
          queryKey: getListConversationMessagesQueryKey(conversation.id),
          exact: false,
        });
      } catch (err_) {
        setPdfError(err_ instanceof Error ? err_.message : "Upload failed");
      } finally {
        setPdfUploading(false);
      }
    },
    [ensureConversation, qc],
  );

  const chatMutation = useChat({ mutation: {} });

  const streamChatDirect = useCallback(
    async (text: string, conversationId: string, messages: ChatMessage[]) => {
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      setIsStreaming(true);
      setStreamingContent("");
      setStreamError(null);
      let fullContent = "";
      try {
        await appendMessage.mutateAsync({
          id: conversationId,
          data: { role: "user", content: text },
        });
        const res = await fetch(`${getApiBase()}/api/chat/stream`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Tenant-ID": getTenantId(),
            "X-Workspace-ID": getWorkspaceId(),
          },
          credentials: "include",
          body: JSON.stringify({
            messages,
            conversationId,
            ...(model ? { model } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Stream request failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") break outer;
            try {
              const chunk = JSON.parse(data) as { delta?: string; error?: string; done?: boolean };
              if (chunk.error) throw new Error(chunk.error);
              fullContent += chunk.delta ?? "";
              setStreamingContent(fullContent);
              messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
            } catch {
              // skip malformed SSE lines
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setStreamError((e as Error).message ?? "Stream error");
        }
      } finally {
        streamAbortRef.current = null;
        setIsStreaming(false);
        if (fullContent) {
          await appendMessage.mutateAsync({
            id: conversationId,
            data: { role: "assistant", content: fullContent },
          });
          // Wait for the messages list to refresh before clearing the streaming
          // bubble — otherwise there is a visible flash where the response
          // disappears between the bubble being removed and the persisted
          // message appearing in the conversation list.
          await qc.refetchQueries({
            queryKey: getListConversationMessagesQueryKey(conversationId),
            exact: false,
          });
        }
        setStreamingContent(null);
      }
    },
    [appendMessage, messagesEndRef, model, qc],
  );

  const createRun = useCreateAgentRun({
    mutation: {
      onSuccess: (resp, vars) => {
        setActiveRunId(resp.data.id);
        setActiveRunSkillId(vars.data.skillId ?? null);
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

  // ---------- Voice interface (Task #9) ----------
  const player = useVoicePlayer();
  const lastSpokenIdRef = useRef<string | null>(null);
  const autoSendOnNextTranscriptRef = useRef(false);

  const synthesize = useSynthesizeSpeech();

  const speakReply = useCallback(
    async (text: string) => {
      if (!settings.voiceMode || !settings.voiceAutoplay) return;
      try {
        const resp = await synthesize.mutateAsync({
          data: {
            text,
            voice: settings.voiceName,
            speed: settings.voiceSpeed,
          },
        });
        await player.play(resp.data.audio, resp.data.mimeType);
      } catch {
        /* surfaced via the mutation error state */
      }
    },
    [
      player,
      settings.voiceAutoplay,
      settings.voiceMode,
      settings.voiceName,
      settings.voiceSpeed,
      synthesize,
    ],
  );

  const transcribeMut = useTranscribeAudio({
    mutation: {
      onSuccess: (resp: any) => {
        const transcript = resp.data.transcript.trim();
        if (!transcript) return;
        if (autoSendOnNextTranscriptRef.current) {
          autoSendOnNextTranscriptRef.current = false;
          void submitText(transcript);
        } else {
          setInput((curr) => (curr ? `${curr} ${transcript}` : transcript));
        }
      },
    },
  });

  const onRecording = useCallback(
    (rec: VoiceRecording) => {
      transcribeMut.mutate({
        data: {
          audio: rec.base64,
          mimeType: rec.mimeType,
          language: "en-US",
        },
      });
    },
    [transcribeMut],
  );

  const recorder = useVoiceRecorder({ onRecording });

  const startVoiceCapture = useCallback(() => {
    // Interrupt any ongoing TTS before opening the mic — feels much more
    // natural and lets the user "talk over" the assistant.
    if (player.isPlaying) player.stop();
    autoSendOnNextTranscriptRef.current = settings.voiceMode;
    void recorder.start();
  }, [player, recorder, settings.voiceMode]);

  useWakeWord({
    enabled: settings.wakeWordEnabled && !recorder.isRecording,
    phrase: settings.wakeWordPhrase,
    onWake: startVoiceCapture,
  });

  useEffect(() => {
    if (pendingApproval && !activeApproval) {
      setActiveApproval(pendingApproval);
    }
  }, [pendingApproval, activeApproval]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversationMessages.length, runMessages.length]);

  // Sync agentMode and model when restoring a conversation so the toggle in
  // the header reflects the thread's persisted preference.
  useEffect(() => {
    if (!activeConversation) return;
    setAgentMode(activeConversation.agentMode);
    if (activeConversation.modelName) {
      setModel(activeConversation.modelName);
    }
    setActiveRunId(null);
    setActiveApproval(null);
  }, [activeConversation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!run || !activeRunId) return;
    if (firstTaskCompleted) return;
    if (!COMPLETED_STATUSES.has(run.status)) return;
    if (sparkleFiredFor.current === activeRunId) return;
    sparkleFiredFor.current = activeRunId;
    setShowSparkle(true);
    markFirstTask.mutate({ data: { firstTaskCompleted: true } });
  }, [run, activeRunId, firstTaskCompleted, markFirstTask]);

  const submitText = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      completeChecklistItem("first-chat");
      if (agentMode) {
        completeChecklistItem("agent-run");
        const conversation = await ensureConversation(text);
        createRun.mutate({
          data: {
            goal: text,
            conversationId: conversation.id,
            ...(model ? { modelName: model } : {}),
            ...(skillId !== "auto" ? { skillId } : {}),
          },
        });
        setLastSentPrompt(text);
        setInput("");
      } else {
        const history: ChatMessage[] = conversationMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
        const newMessages: ChatMessage[] = [
          ...history,
          { role: "user", content: text },
        ];
        const conversation =
          activeConversation ?? (await ensureConversation(text));
        setLastSentPrompt(text);
        setInput("");
        void streamChatDirect(text, conversation.id, newMessages);
      }
    },
    [
      agentMode,
      activeConversation,
      streamChatDirect,
      conversationMessages,
      createRun,
      ensureConversation,
      model,
      skillId,
      completeChecklistItem,
    ],
  );

  const submit = () => void submitText(input);

  // Speak the most recent assistant turn whenever it changes (voice mode
  // only). We keep a ref of the last id we spoke so toggling voice mode
  // mid-conversation doesn't replay older replies.
  useEffect(() => {
    if (!settings.voiceMode || !settings.voiceAutoplay) return;
    const lastMsg = conversationMessages[conversationMessages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      if (lastSpokenIdRef.current !== lastMsg.id) {
        lastSpokenIdRef.current = lastMsg.id;
        void speakReply(lastMsg.content);
      }
    }
    const lastAgentMsg = [...runMessages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAgentMsg && lastSpokenIdRef.current !== lastAgentMsg.id) {
      lastSpokenIdRef.current = lastAgentMsg.id;
      void speakReply(lastAgentMsg.content);
    }
  }, [
    conversationMessages,
    runMessages,
    settings.voiceMode,
    settings.voiceAutoplay,
    speakReply,
  ]);

  // Pick up resolved prompt from Templates page hand-off.
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem("omninity:pendingPrompt");
      if (pending) {
        setInput(pending);
        const wantAgent =
          sessionStorage.getItem("omninity:pendingPromptAgent") === "1";
        if (wantAgent) setAgentMode(true);
        sessionStorage.removeItem("omninity:pendingPrompt");
        sessionStorage.removeItem("omninity:pendingPromptAgent");
      }
    } catch {
      // sessionStorage may be unavailable; safe to ignore.
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const newConversation = () => {
    setActiveConversation(null);
    setActiveRunId(null);
    setActiveRunSkillId(null);
    setActiveApproval(null);
    setAttachedPdf(null);
    setPdfError(null);
  };

  const headerActions = (
    <div className="flex items-center gap-3">
      <VoiceModeToggle
        enabled={settings.voiceMode}
        onChange={(next) => updateSettings({ voiceMode: next })}
        isPlaying={player.isPlaying}
        onInterrupt={player.stop}
      />
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
      title={
        activeConversation
          ? activeConversation.title
          : agentMode
            ? "Agent run"
            : "Chat"
      }
      description={
        agentMode
          ? "Multi-agent execution with plans, tools, and approvals."
          : "Direct conversation with the local model."
      }
      actions={headerActions}
    >
      <div className="grid h-full grid-cols-[auto_1fr] grid-rows-1">
        <ConversationSidebar
          activeId={activeConversation?.id ?? null}
          onSelect={(c) => setActiveConversation(c)}
          onNew={newConversation}
        />

        <div className="grid min-h-0 grid-rows-[1fr_auto] lg:grid-cols-[1fr_360px]">
          <section className="flex min-h-0 flex-col overflow-hidden border-r border-border">
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {agentMode ? (
                <AgentTranscript
                  runId={activeRunId}
                  messages={runMessages}
                  conversationMessages={conversationMessages}
                  isLoading={messagesQuery.isLoading}
                  modelUsed={run?.modelName ?? null}
                  skillName={
                    activeRunSkillId
                      ? installedSkills.find((s) => s.id === activeRunSkillId)
                          ?.name ?? null
                      : null
                  }
                />
              ) : (
                <ChatTranscript
                  messages={conversationMessages}
                  conversationId={activeConversation?.id ?? null}
                  onTogglePin={(msg) => {
                    if (!activeConversation) return;
                    const args = {
                      id: activeConversation.id,
                      msgId: msg.id,
                    };
                    if (msg.pinned) unpinMessage.mutate(args);
                    else pinMessage.mutate(args);
                  }}
                />
              )}
              {streamingContent !== null && (
                <div className="mx-auto mt-4 max-w-3xl rounded-lg border border-border bg-muted/40 p-4">
                  <div className="mb-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Assistant
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-foreground">
                    {streamingContent}
                    <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current" />
                  </p>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-border bg-background/95 px-6 py-4">
              <ErrorBanner
                error={
                  (streamError ? new Error(streamError) : null) ??
                  createRun.error ??
                  transcribeMut.error ??
                  synthesize.error ??
                  (recorder.error ? new Error(recorder.error) : null)
                }
                className="mb-3"
              />
              {recorder.isRecording ||
              transcribeMut.isPending ||
              player.isPlaying ? (
                <div
                  className="mb-2 flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2"
                  data-testid="voice-status-bar"
                >
                  <Waveform
                    active={recorder.isRecording || player.isPlaying}
                    level={player.isPlaying ? player.level : recorder.level}
                    variant={player.isPlaying ? "output" : "input"}
                    className="w-32"
                  />
                  <span className="flex-1 truncate text-xs text-muted-foreground">
                    {recorder.isRecording
                      ? recorder.liveCaption || "Listening — release to send."
                      : transcribeMut.isPending
                        ? "Transcribing…"
                        : "Speaking…"}
                  </span>
                  {player.isPlaying ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={player.stop}
                      data-testid="button-interrupt-inline"
                      className="h-7 px-2 text-xs"
                    >
                      Stop
                    </Button>
                  ) : null}
                </div>
              ) : (agentMode
                ? !activeRunId
                : conversationMessages.length === 0) ? (
                <div className="mb-3 space-y-3">
                  <StarterChips onPick={(prompt) => setInput(prompt)} />
                  <InlineHints onPick={(prompt) => setInput(prompt)} />
                </div>
              ) : null}
              {agentMode ? (
                <div
                  className="mb-3 flex flex-wrap items-center gap-1.5"
                  data-testid="skill-chips"
                >
                  <span className="mr-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Skill
                  </span>
                  <button
                    type="button"
                    data-testid="skill-chip-auto"
                    onClick={() => setSkillId("auto")}
                    className={cn(
                      "hover-elevate rounded-full border px-3 py-1 text-xs",
                      skillId === "auto"
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground",
                    )}
                  >
                    Auto-route
                  </button>
                  {installedSkills.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      data-testid={`skill-chip-${s.id}`}
                      onClick={() => setSkillId(s.id)}
                      className={cn(
                        "hover-elevate rounded-full border px-3 py-1 text-xs",
                        skillId === s.id
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground",
                      )}
                    >
                      {s.name}
                    </button>
                  ))}
                  {installedSkills.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                      No skills installed yet — visit the Skills page to add one.
                    </span>
                  ) : null}
                </div>
              ) : null}
              {activeConversation ? (
                <ContextUsageBar
                  usage={contextUsage}
                  modelName={model}
                  onReset={() =>
                    resetContext.mutate({ id: activeConversation.id })
                  }
                  busy={resetContext.isPending}
                />
              ) : null}
              <QuickLaunchBar
                onResolved={(resolvedPrompt, tpl) => {
                  setInput(resolvedPrompt);
                  if (tpl.skillConfig?.agentMode) setAgentMode(true);
                }}
              />
              {attachedPdf ? (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-muted-foreground">
                    {attachedPdf.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setAttachedPdf(null); setPdfError(null); }}
                    className="ml-1 rounded p-0.5 hover:bg-muted"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              ) : null}
              {pdfError ? (
                <p className="mb-1 text-xs text-destructive">{pdfError}</p>
              ) : null}
              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => void handlePdfSelect(e)}
              />
              <div className="flex flex-col gap-1.5">
                <Textarea
                  data-testid="input-chat"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={
                    agentMode
                      ? "Describe a goal for the agent…"
                      : settings.voiceMode
                        ? "Hold the mic, or type — voice mode is on."
                        : "Send a message…"
                  }
                  className="min-h-[72px] max-h-48 resize-none"
                  disabled={isStreaming || createRun.isPending}
                />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => pdfInputRef.current?.click()}
                      disabled={pdfUploading || isStreaming}
                      aria-label="Attach PDF"
                      title="Attach PDF"
                      data-testid="button-attach-pdf"
                    >
                      {pdfUploading ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <Paperclip className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => setSaveTemplateOpen(true)}
                      disabled={!input.trim() && !lastSentPrompt}
                      aria-label="Save as template"
                      title="Save as template"
                      data-testid="button-save-as-template"
                    >
                      <Bookmark className="h-4 w-4" />
                    </Button>
                    {agentMode &&
                    activeRunId &&
                    run &&
                    !TERMINAL_STATUSES.has(run.status) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => cancelRun.mutate({ id: activeRunId })}
                        disabled={cancelRun.isPending}
                        aria-label="Cancel run"
                        data-testid="button-cancel-run"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <MicButton
                      isRecording={recorder.isRecording}
                      isBusy={transcribeMut.isPending}
                      onStart={startVoiceCapture}
                      onStop={recorder.stop}
                      onCancel={recorder.cancel}
                    />
                    <Button
                      size="icon"
                      onClick={submit}
                      disabled={
                        !input.trim() ||
                        isStreaming ||
                        createRun.isPending
                      }
                      aria-label="Send"
                      data-testid="button-send"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
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
                    <CardTitle className="text-sm">
                      Execution timeline
                    </CardTitle>
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
                            a.decision === "pending" &&
                              "border-amber-500/40",
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
            ? toolCalls.find((c) => c.id === activeApproval.toolCallId)
                ?.riskLevel
            : undefined
        }
        toolName={
          activeApproval
            ? toolCalls.find((c) => c.id === activeApproval.toolCallId)
                ?.toolName
            : undefined
        }
        inputPreview={
          activeApproval
            ? toolCalls.find((c) => c.id === activeApproval.toolCallId)?.input
            : undefined
        }
      />

      <SuccessSparkle show={showSparkle} onDone={() => setShowSparkle(false)} />
      <SaveTemplateDialog
        open={saveTemplateOpen}
        onOpenChange={setSaveTemplateOpen}
        initialPrompt={input.trim() || lastSentPrompt}
        initialAgentMode={agentMode}
        initialModel={model}
        initialConversationId={activeConversation?.id ?? null}
      />

      <ChatReadyMarker />
    </OperatorLayout>
  );
}

function ChatTranscript({
  messages,
  conversationId,
  onTogglePin,
}: {
  messages: ConversationMessage[];
  conversationId?: string | null;
  onTogglePin?: (msg: ConversationMessage) => void;
}) {
  if (messages.length === 0) {
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
      {messages.map((m) => {
        if (m.isSummary) {
          // Summary banner — visually distinct from regular turns so the
          // user knows the model sees a compressed version of earlier
          // history (Task #51).
          return (
            <div
              key={m.id}
              className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-4"
              data-testid="chat-summary-banner"
            >
              <div className="mb-1 flex items-center gap-2">
                <Sparkles className="h-3 w-3 text-amber-600" />
                <span className="text-xs font-medium uppercase tracking-wide text-amber-700">
                  Earlier conversation summarised
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(m.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {m.content}
              </p>
            </div>
          );
        }
        return (
          <div
            key={m.id}
            className={cn(
              "group relative rounded-lg border border-border p-4",
              m.role === "user" ? "bg-card" : "bg-muted/40",
              m.pinned && "ring-1 ring-primary/40",
            )}
            data-testid={`chat-turn-${m.role}`}
            data-pinned={m.pinned ? "true" : "false"}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {m.role === "user" ? "You" : m.role === "assistant" ? "Assistant" : m.role}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(m.createdAt).toLocaleTimeString()}
              </span>
              {m.pinned ? (
                <span
                  className="flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                  data-testid={`message-pinned-${m.id}`}
                >
                  <Pin className="h-2.5 w-2.5" /> pinned
                </span>
              ) : null}
              {conversationId && onTogglePin ? (
                <button
                  type="button"
                  onClick={() => onTogglePin(m)}
                  className="ml-auto rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 data-[pinned=true]:opacity-100"
                  data-pinned={m.pinned ? "true" : "false"}
                  data-testid={`button-pin-${m.id}`}
                  aria-label={m.pinned ? "Unpin message" : "Pin message"}
                  title={
                    m.pinned
                      ? "Unpin — let this turn be summarised again"
                      : "Pin — keep this turn verbatim in context"
                  }
                >
                  {m.pinned ? (
                    <PinOff className="h-3.5 w-3.5" />
                  ) : (
                    <Pin className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {m.content}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function AgentTranscript({
  runId,
  messages,
  conversationMessages,
  isLoading,
  modelUsed,
  skillName,
}: {
  runId: string | null;
  messages: Message[];
  conversationMessages: ConversationMessage[];
  isLoading: boolean;
  modelUsed: string | null;
  skillName: string | null;
}) {
  // Prefer the per-run transcript when an agent run is active so we get the
  // full system / user / assistant timeline. When no run is selected but the
  // conversation has prior turns, replay those (context restoration on reload).
  if (!runId) {
    if (conversationMessages.length > 0) {
      return <ChatTranscript messages={conversationMessages} />;
    }
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
      {messages.map((m) => {
        // Each assistant turn carries an attribution receipt so users can see
        // which skill (if any) and which local model produced the response.
        const showAttribution = m.role === "assistant";
        const isPaywall =
          m.role === "system" && m.content.includes("requires a Creator Pro subscription");
        if (isPaywall) {
          return (
            <div
              key={m.id}
              className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
              data-testid="agent-message-paywall"
            >
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-600">
                Premium skill locked
              </div>
              <p className="mb-3 whitespace-pre-wrap text-sm text-foreground">{m.content}</p>
              <a
                href="/subscription"
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
                data-testid="link-subscribe"
              >
                Subscribe to unlock
              </a>
            </div>
          );
        }
        return (
          <div
            key={m.id}
            className={cn(
              "rounded-lg border border-border p-4",
              m.role === "user" ? "bg-card" : "bg-muted/40",
            )}
            data-testid={`agent-message-${m.role}`}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {m.role}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(m.createdAt).toLocaleTimeString()}
              </span>
              {showAttribution && (modelUsed || skillName) ? (
                <span
                  className="ml-auto flex items-center gap-2"
                  data-testid={`message-attribution-${m.id}`}
                >
                  {skillName ? (
                    <Badge variant="outline" className="text-[10px]">
                      Skill: {skillName}
                    </Badge>
                  ) : null}
                  {modelUsed ? (
                    <Badge variant="secondary" className="text-[10px] font-mono">
                      {modelUsed}
                    </Badge>
                  ) : null}
                </span>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {m.content}
            </p>
          </div>
        );
      })}
    </div>
  );
}
