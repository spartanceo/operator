/**
 * LaunchSequence — first-run onboarding screen.
 *
 * A single, full-screen animated timeline that auto-advances through six
 * steps with no "Next" buttons. The sequence only pauses when Ollama is
 * not installed, at which point it shows a download link and polls silently
 * every 2 s until the daemon responds.
 *
 * Steps:
 *  1. account-created  — always complete on mount (tick shown immediately)
 *  2. ollama-check     — GET /api/onboarding/ollama-status every 2 s
 *  3. hardware-scan    — GET /api/onboarding/hardware (chip, RAM, tier)
 *  4. model-selection  — chip-class + RAM hardware→model mapping table
 *  5. model-pull       — POST /api/models/install + poll install/status
 *  6. embed-pull       — POST /api/models/pull (nomic-embed-text, ~274 MB)
 *  7. ready            — mark profile complete, navigate to /chat
 *
 * Error handling:
 *  - If primary model pull fails (step 5), progression stops and an error
 *    state is shown. The user must reload to retry — no silent completion.
 *  - If nomic-embed-text pull fails (step 6), progression stops and an
 *    error state is shown. Onboarding is NOT marked complete.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Check,
  Loader2,
  AlertTriangle,
  Download,
  Zap,
} from "lucide-react";
import { ImageGenSetupCard } from "@/components/operator/image-gen-setup-card";
import {
  useGetOnboardingOllamaStatus,
  useGetOnboardingHardware,
  useInstallModels,
  useGetModelsInstallStatus,
  usePullModel,
  useUpsertOnboardingProfile,
  type ModelInstallState,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

const EMBED_MODEL_ID = "nomic-embed-text";
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download/mac";

interface LaunchSequenceProps {
  onComplete: () => void;
}

/** Hardware-to-model mapping result. */
interface ModelChoice {
  id: string;
  displayName: string;
  rationale: string;
}

/**
 * Maps detected chip class + RAM to the recommended model.
 *
 * Mapping table:
 * | Intel Mac          | Any     | llama3.2:3b  |
 * | M1 / M2 (base)     | ≤8 GB   | llama3.2:3b  |
 * | Any Apple Silicon  | 16-18GB | llama3.1:8b  |
 * | M2 Pro/Max / M3Pro | 32 GB   | llama3.1:8b  |
 * | M3 Max / Ultra     | 64 GB+  | llama3.1:70b |
 *
 * Chip class is detected from `cpuModel` (e.g. "Apple M3 Pro").
 * RAM thresholds are applied after chip class for accuracy.
 */
function pickModel(
  appleSilicon: boolean,
  totalRamBytes: number,
  cpuModel: string | null,
): ModelChoice {
  const gb = totalRamBytes / (1024 * 1024 * 1024);

  if (!appleSilicon) {
    return {
      id: "llama3.2:3b",
      displayName: "Llama 3.2 3B",
      rationale: "CPU-only Intel Mac — keeping it small and fast.",
    };
  }

  const chip = (cpuModel ?? "").toLowerCase();
  // Detect chip generation explicitly — 70B is only assigned to M3 Max/Ultra per spec.
  const isM3 = chip.includes("m3");
  const isMaxOrUltra = chip.includes("max") || chip.includes("ultra");
  const isPro = chip.includes("pro") && !isMaxOrUltra;

  // M3 Max / Ultra only: 64 GB+ (threshold at 56 GB to catch 64/96/128/192 GB configs).
  // M2 Max/Ultra intentionally falls through to the 32B tier below.
  if (isM3 && isMaxOrUltra && gb >= 56) {
    return {
      id: "llama3.1:70b",
      displayName: "Llama 3.1 70B",
      rationale:
        "Near GPT-4 quality — M3 Max/Ultra with 64 GB+.",
    };
  }

  // M2 Pro/Max or M3 Pro: 32 GB — best real model that fits comfortably
  if ((isMaxOrUltra || isPro) && gb >= 28) {
    return {
      id: "llama3.1:8b",
      displayName: "Llama 3.1 8B",
      rationale:
        "Fast and capable — runs perfectly on M2/M3 Pro at 32 GB.",
    };
  }

  // Any Apple Silicon with 16–18 GB (threshold at 14 GB to catch 16/18 GB configs)
  if (gb >= 14) {
    return {
      id: "llama3.1:8b",
      displayName: "Llama 3.1 8B",
      rationale:
        "Apple Silicon bandwidth handles 8B smoothly at 16–18 GB.",
    };
  }

  // M1 / M2 base with 8 GB (or any Apple Silicon under 12 GB)
  return {
    id: "llama3.2:3b",
    displayName: "Llama 3.2 3B",
    rationale: "Fits perfectly in 8 GB — stays fast on M1/M2.",
  };
}

function formatRam(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${Math.round(gb)} GB`;
}

type StepStatus = "pending" | "active" | "done" | "error";

const STEP_IDS = [
  "account",
  "ollama",
  "hardware",
  "model",
  "pull",
  "embed",
] as const;

type StepId = (typeof STEP_IDS)[number];

export function LaunchSequence({ onComplete }: LaunchSequenceProps) {
  const [, navigate] = useLocation();

  // ── Active step tracking ──────────────────────────────────────────
  const [activeStep, setActiveStep] = useState<StepId>("account");
  const [doneSteps, setDoneSteps] = useState<Set<StepId>>(new Set());
  // errorStep is set when a pull fails — progression halts
  const [errorStep, setErrorStep] = useState<StepId | null>(null);

  // ── Ollama check ──────────────────────────────────────────────────
  const [ollamaPolling, setOllamaPolling] = useState(false);
  const ollamaStatusQuery = useGetOnboardingOllamaStatus({
    query: {
      enabled: ollamaPolling,
      refetchInterval: ollamaPolling ? 2000 : false,
      retry: false,
      refetchIntervalInBackground: true,
    } as never,
  });
  const ollamaRunning = ollamaStatusQuery.data?.data.running ?? false;

  // ── Hardware scan ─────────────────────────────────────────────────
  const [hardwareEnabled, setHardwareEnabled] = useState(false);
  const hardwareQuery = useGetOnboardingHardware({
    query: { enabled: hardwareEnabled, retry: false } as never,
  });
  const hardware = hardwareQuery.data?.data.hardware ?? null;

  // ── Model selection ───────────────────────────────────────────────
  const [chosenModel, setChosenModel] = useState<ModelChoice | null>(null);

  // ── Primary model install ─────────────────────────────────────────
  const [installStarted, setInstallStarted] = useState(false);
  const [installState, setInstallState] = useState<ModelInstallState | null>(null);
  const installMutation = useInstallModels();
  const installPolling =
    installState !== null && installState.status === "running";
  const installStatusQuery = useGetModelsInstallStatus({
    query: {
      enabled: installPolling,
      refetchInterval: installPolling ? 1000 : false,
      retry: false,
    } as never,
  });

  // ── Embed model pull ──────────────────────────────────────────────
  const [embedStarted, setEmbedStarted] = useState(false);
  const [embedDone, setEmbedDone] = useState(false);
  const [embedFailed, setEmbedFailed] = useState(false);
  const pullMutation = usePullModel();

  // ── Onboarding completion ─────────────────────────────────────────
  const [completing, setCompleting] = useState(false);
  const upsert = useUpsertOnboardingProfile();

  // Keep install state synced from poll
  useEffect(() => {
    const next = installStatusQuery.data?.data;
    if (next) setInstallState(next);
  }, [installStatusQuery.data]);

  // ── Step machine ──────────────────────────────────────────────────
  const ranRef = useRef<Partial<Record<StepId, boolean>>>({});

  const markDone = (id: StepId) => {
    setDoneSteps((prev) => new Set([...prev, id]));
  };
  const advance = (from: StepId, to: StepId) => {
    markDone(from);
    setActiveStep(to);
  };

  // Step 1 — account: done immediately on mount
  useEffect(() => {
    if (ranRef.current["account"]) return;
    ranRef.current["account"] = true;
    const t = setTimeout(() => {
      advance("account", "ollama");
      setOllamaPolling(true);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 2 — ollama: wait for running, then advance to hardware
  useEffect(() => {
    if (activeStep !== "ollama") return;
    if (!ollamaRunning) return;
    if (ranRef.current["ollama"]) return;
    ranRef.current["ollama"] = true;
    setOllamaPolling(false);
    advance("ollama", "hardware");
    setHardwareEnabled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, ollamaRunning]);

  // Step 3 — hardware: once probe returns, advance to model selection
  useEffect(() => {
    if (activeStep !== "hardware") return;
    if (!hardware) return;
    if (ranRef.current["hardware"]) return;
    ranRef.current["hardware"] = true;
    const t = setTimeout(() => {
      advance("hardware", "model");
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, hardware]);

  // Step 4 — model: pick model using chip class + RAM, advance to pull
  useEffect(() => {
    if (activeStep !== "model") return;
    if (!hardware) return;
    if (ranRef.current["model"]) return;
    ranRef.current["model"] = true;
    const choice = pickModel(
      hardware.appleSilicon,
      hardware.totalRamBytes,
      hardware.cpuModel ?? null,
    );
    setChosenModel(choice);
    const t = setTimeout(() => {
      advance("model", "pull");
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, hardware]);

  // Step 5 — pull: kick off install, poll until terminal state
  useEffect(() => {
    if (activeStep !== "pull") return;
    if (installStarted) return;
    if (!chosenModel) return;
    setInstallStarted(true);
    installMutation.mutate(
      { data: { primaryModel: chosenModel.id, includeVision: false } },
      {
        onSuccess: (resp) => setInstallState(resp.data),
        // If the kickoff request itself fails (network/server error), surface
        // a terminal error state so the step doesn't stay active indefinitely.
        onError: () => setErrorStep("pull"),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, chosenModel]);

  // Detect primary install terminal state.
  // CRITICAL: only advance on "completed". "failed" halts progression.
  useEffect(() => {
    if (activeStep !== "pull") return;
    if (!installState) return;
    if (installState.status === "completed") {
      if (ranRef.current["pull"]) return;
      ranRef.current["pull"] = true;
      advance("pull", "embed");
    } else if (installState.status === "failed") {
      setErrorStep("pull");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, installState]);

  // Step 6 — embed: pull nomic-embed-text only after primary succeeds
  useEffect(() => {
    if (activeStep !== "embed") return;
    if (embedStarted) return;
    setEmbedStarted(true);
    pullMutation.mutate(
      { data: { name: EMBED_MODEL_ID } },
      {
        onSuccess: () => setEmbedDone(true),
        // Embed failure is a real failure — do NOT mark onboarding complete
        onError: () => setEmbedFailed(true),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep]);

  // Detect embed completion (success only)
  useEffect(() => {
    if (activeStep !== "embed") return;
    if (!embedDone) return;
    if (ranRef.current["embed"]) return;
    ranRef.current["embed"] = true;
    markDone("embed");
    const t = setTimeout(() => {
      if (completing) return;
      setCompleting(true);
      upsert.mutate(
        {
          data: {
            completed: true,
            ...(chosenModel ? { recommendedModel: chosenModel.id } : {}),
            ...(hardware ? { hardwareSnapshot: hardware } : {}),
          },
        },
        {
          onSuccess: () => {
            onComplete();
            void navigate("/chat");
          },
        },
      );
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, embedDone]);

  // ── Derived install progress values ──────────────────────────────
  const primaryEntry = installState?.models.find((m) => m.role === "primary");
  const installPercent = primaryEntry?.percent ?? 0;
  const installLabel =
    primaryEntry?.status === "pulling"
      ? `${installPercent}%`
      : primaryEntry?.status === "ready"
      ? "Done"
      : "Starting…";

  // ── Determine per-step status ─────────────────────────────────────
  const statusFor = (id: StepId): StepStatus => {
    if (errorStep === id) return "error";
    if (doneSteps.has(id)) return "done";
    if (activeStep === id) return "active";
    return "pending";
  };

  const ollamaStepStatus = statusFor("ollama");
  const ollamaNotRunning =
    ollamaStepStatus === "active" &&
    !ollamaRunning &&
    ollamaStatusQuery.isFetched;

  const hasPullError = errorStep === "pull";
  const hasEmbedError = embedFailed;

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-10 flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/10 text-primary">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Setting up
            </p>
            <p className="text-sm font-semibold text-foreground">
              Omninity Operator
            </p>
          </div>
        </div>

        {/* Timeline */}
        <ol className="relative space-y-0">
          <TimelineStep
            status={statusFor("account")}
            label="Account created"
            detail="Signed in and ready to go."
            isLast={false}
          />

          <TimelineStep
            status={ollamaStepStatus}
            label="Checking for Ollama"
            detail={
              ollamaStepStatus === "done"
                ? "Ollama is running."
                : ollamaNotRunning
                ? undefined
                : ollamaStepStatus === "active"
                ? "Connecting to local AI runtime…"
                : undefined
            }
            extra={ollamaNotRunning ? <OllamaInstallPrompt /> : undefined}
            isLast={false}
          />

          <TimelineStep
            status={statusFor("hardware")}
            label="Scanning hardware"
            detail={
              hardware && doneSteps.has("hardware")
                ? `${hardware.appleSilicon ? (hardware.cpuModel ?? "Apple Silicon") : "Intel"} · ${formatRam(hardware.totalRamBytes)} RAM`
                : statusFor("hardware") === "active"
                ? "Reading chip and memory…"
                : undefined
            }
            isLast={false}
          />

          <TimelineStep
            status={statusFor("model")}
            label="Selecting model"
            detail={
              chosenModel &&
              (doneSteps.has("model") ||
                activeStep === "pull" ||
                activeStep === "embed" ||
                completing)
                ? `${chosenModel.displayName} — ${chosenModel.rationale}`
                : statusFor("model") === "active"
                ? "Matching model to your hardware…"
                : undefined
            }
            isLast={false}
          />

          <TimelineStep
            status={hasPullError ? "error" : statusFor("pull")}
            label={`Pulling ${chosenModel?.displayName ?? "primary model"}`}
            detail={
              statusFor("pull") === "done"
                ? "Model ready."
                : hasPullError
                ? "Pull failed — see error below."
                : statusFor("pull") === "active"
                ? installLabel
                : undefined
            }
            extra={
              statusFor("pull") === "active" && installStarted ? (
                <div className="mt-2 space-y-1">
                  <Progress value={installPercent} className="h-1.5" />
                  {primaryEntry?.status === "pulling" && (
                    <p className="text-xs text-muted-foreground">
                      {installPercent}% complete
                    </p>
                  )}
                </div>
              ) : undefined
            }
            isLast={false}
          />

          <TimelineStep
            status={hasEmbedError ? "error" : statusFor("embed")}
            label="Pulling nomic-embed-text"
            detail={
              statusFor("embed") === "done"
                ? "Knowledge base search ready."
                : hasEmbedError
                ? "Pull failed — see error below."
                : statusFor("embed") === "active"
                ? "Pulling embedding model (~274 MB)…"
                : "For knowledge base search (274 MB)"
            }
            extra={
              statusFor("embed") === "active" && !embedDone && !embedFailed ? (
                <div className="mt-2">
                  <Progress value={undefined} className="h-1.5 animate-pulse" />
                </div>
              ) : undefined
            }
            isLast={true}
          />
        </ol>

        {/* Completing state */}
        {completing && (
          <div className="mt-10 space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Opening Operator…
            </div>
            <ImageGenSetupCard
              onNavigateToSettings={() => void navigate("/settings")}
            />
          </div>
        )}

        {/* Error state — primary model pull failed */}
        {hasPullError && (
          <ErrorBanner
            title="Primary model pull failed"
            message="Ollama may have lost its connection. Check that Ollama is still running, then reload the page to try again."
          />
        )}

        {/* Error state — embed model pull failed */}
        {hasEmbedError && !hasPullError && (
          <ErrorBanner
            title="Embedding model pull failed"
            message={`Could not pull ${EMBED_MODEL_ID}. Check that Ollama is still running, then reload the page to try again.`}
          />
        )}
      </div>
    </div>
  );
}

function ErrorBanner({ title, message }: { title: string; message: string }) {
  return (
    <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-destructive/80">{message}</p>
        </div>
      </div>
    </div>
  );
}

function OllamaInstallPrompt() {
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/40 p-4">
      <p className="text-sm font-medium text-foreground">
        Ollama is not running
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Download and open Ollama for Mac. The setup will continue automatically
        the moment it starts — no need to come back here.
      </p>
      <a
        href={OLLAMA_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-block"
      >
        <Button size="sm" variant="outline" className="gap-2">
          <Download className="h-3.5 w-3.5" />
          Download Ollama for Mac
        </Button>
      </a>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Waiting for Ollama to start…
      </p>
    </div>
  );
}

interface TimelineStepProps {
  status: StepStatus;
  label: string;
  detail?: string;
  extra?: React.ReactNode;
  isLast: boolean;
}

function TimelineStep({
  status,
  label,
  detail,
  extra,
  isLast,
}: TimelineStepProps) {
  return (
    <li className="flex gap-4">
      {/* Connector column */}
      <div className="flex flex-col items-center">
        <StepIcon status={status} />
        {!isLast && (
          <div
            className={cn(
              "mt-1 w-px flex-1 transition-colors duration-500",
              status === "done" ? "bg-primary/40" : "bg-border",
            )}
            style={{ minHeight: "2rem" }}
          />
        )}
      </div>

      {/* Content column */}
      <div className={cn("pb-6 min-w-0 flex-1", isLast && "pb-0")}>
        <p
          className={cn(
            "text-sm font-medium leading-tight transition-colors",
            status === "error"
              ? "text-destructive"
              : status === "done" || status === "active"
              ? "text-foreground"
              : "text-muted-foreground/60",
          )}
        >
          {label}
        </p>
        {detail && (
          <p
            className={cn(
              "mt-0.5 text-xs transition-colors",
              status === "error"
                ? "text-destructive/70"
                : status === "done"
                ? "text-muted-foreground"
                : "text-muted-foreground/70",
            )}
          >
            {detail}
          </p>
        )}
        {extra}
      </div>
    </li>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  const base =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-300";
  if (status === "done") {
    return (
      <div
        className={cn(
          base,
          "border-primary bg-primary text-primary-foreground",
        )}
      >
        <Check className="h-3 w-3" strokeWidth={2.5} />
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className={cn(base, "border-primary bg-primary/10")}>
        <Loader2 className="h-3 w-3 animate-spin text-primary" />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className={cn(base, "border-destructive bg-destructive/10")}>
        <AlertTriangle className="h-3 w-3 text-destructive" />
      </div>
    );
  }
  return (
    <div className={cn(base, "border-border bg-background")}>
      <div className="h-1.5 w-1.5 rounded-full bg-border" />
    </div>
  );
}
