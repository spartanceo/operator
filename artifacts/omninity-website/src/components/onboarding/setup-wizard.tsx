import { useEffect, useMemo, useState } from "react";
import {
  Cpu,
  Sparkles,
  Download,
  Check,
  Loader2,
  HardDrive,
  Wand2,
  AlertTriangle,
  Eye,
} from "lucide-react";
import {
  useGetModelsRecommended,
  useGetOnboardingHardware,
  useSelectModel,
  useUpsertOnboardingProfile,
  type HardwareProfile,
  type ModelCatalogueEntry,
  type ModelInstallPlan,
  type ModelRecommendation,
  type MinimumSpecVerdict,
  type OnboardingProfile,
  type SelectModelRequestVisionLifecycleMode,
  type UpsertOnboardingProfileRequest,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ErrorBanner } from "@/components/operator/error-banner";
import { cn } from "@/lib/utils";

type UserType = NonNullable<UpsertOnboardingProfileRequest["userType"]>;
type UseCase = NonNullable<UpsertOnboardingProfileRequest["useCase"]>;

interface SetupWizardProps {
  initialProfile: OnboardingProfile | null;
  onComplete: () => void;
}

const USER_TYPES: ReadonlyArray<{
  value: UserType;
  title: string;
  description: string;
}> = [
  {
    value: "personal",
    title: "Personal",
    description: "Just me — productivity, writing, research.",
  },
  {
    value: "business",
    title: "Business",
    description: "Customers, revenue, operations.",
  },
  {
    value: "developer",
    title: "Developer",
    description: "Code, automation, tools.",
  },
];

const USE_CASES: ReadonlyArray<{
  value: UseCase;
  title: string;
  description: string;
}> = [
  {
    value: "productivity",
    title: "Productivity",
    description: "Inbox, notes, planning.",
  },
  {
    value: "sales",
    title: "Sales",
    description: "Prospecting, follow-ups, pipeline.",
  },
  {
    value: "creative",
    title: "Creative work",
    description: "Brainstorming, drafting, editing.",
  },
  {
    value: "coding",
    title: "Coding",
    description: "Reviews, tests, debugging.",
  },
  {
    value: "research",
    title: "Research",
    description: "Deep dives, comparisons, sources.",
  },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

const STEPS = ["welcome", "identity", "useCase", "model"] as const;
type Step = (typeof STEPS)[number];

export function SetupWizard({ initialProfile, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [displayName, setDisplayName] = useState(
    initialProfile?.displayName ?? "",
  );
  const [userType, setUserType] = useState<UserType | null>(
    (initialProfile?.userType as UserType | null) ?? null,
  );
  const [useCase, setUseCase] = useState<UseCase | null>(
    (initialProfile?.useCase as UseCase | null) ?? null,
  );
  const [installProgress, setInstallProgress] = useState<number | null>(null);

  const hardwareQuery = useGetOnboardingHardware();
  const recommendedQuery = useGetModelsRecommended();
  const upsert = useUpsertOnboardingProfile();
  const selectModel = useSelectModel();

  const stepIndex = STEPS.indexOf(step);

  const hardware: HardwareProfile | null =
    hardwareQuery.data?.data.hardware ?? null;
  const recommendation: ModelRecommendation | null =
    hardwareQuery.data?.data.recommendation ?? null;

  const plan: ModelInstallPlan | null =
    recommendedQuery.data?.data.plan ?? null;
  const minimumSpec: MinimumSpecVerdict | null =
    recommendedQuery.data?.data.minimumSpec ?? null;

  // Default chosen model to the recommended primary as soon as the plan
  // loads — keeps "Continue" enabled without forcing a click on the card.
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [visionMode, setVisionMode] =
    useState<SelectModelRequestVisionLifecycleMode>("balanced");
  useEffect(() => {
    if (chosenModel === null && plan) setChosenModel(plan.primary.id);
  }, [plan, chosenModel]);
  useEffect(() => {
    const saved = recommendedQuery.data?.data.preferences.visionLifecycle.mode;
    if (saved) setVisionMode(saved as SelectModelRequestVisionLifecycleMode);
  }, [recommendedQuery.data]);

  // Persist progress on every step transition so a refresh resumes the
  // wizard mid-flow rather than dropping the user back to "welcome".
  const persistStep = (patch: UpsertOnboardingProfileRequest) => {
    upsert.mutate({ data: patch });
  };

  const goNext = (patch?: UpsertOnboardingProfileRequest) => {
    if (patch) persistStep(patch);
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  };

  const goBack = () => {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  };

  // Simulated download progress for the recommended model. Real Ollama
  // pulls stream from /api/models/pull; this loop keeps the UX honest
  // about "this takes time" without coupling the wizard to model state.
  useEffect(() => {
    if (step !== "model" || installProgress === null) return;
    if (installProgress >= 100) return;
    const t = setTimeout(() => {
      setInstallProgress((p) => Math.min(100, (p ?? 0) + 5));
    }, 220);
    return () => clearTimeout(t);
  }, [step, installProgress]);

  const completeWizard = () => {
    const finalModelId = chosenModel ?? plan?.primary.id ?? recommendation?.model;
    // Persist the user's model + vision-lifecycle pick to the new
    // /api/models/select endpoint. Fire-and-forget — failure here doesn't
    // block onboarding completion (the recommendation is regenerated on
    // every launch from hardware), but a successful select makes the chat
    // header reflect the chosen model immediately.
    if (finalModelId) {
      selectModel.mutate({
        data: {
          primaryModel: finalModelId,
          visionLifecycleMode: visionMode,
        },
      });
    }
    upsert.mutate(
      {
        data: {
          completed: true,
          ...(finalModelId ? { recommendedModel: finalModelId } : {}),
          ...(hardware ? { hardwareSnapshot: hardware } : {}),
        },
      },
      {
        onSuccess: () => onComplete(),
      },
    );
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-10">
      <div className="mb-8 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            First-run setup
          </p>
          <p className="text-sm font-medium text-foreground">
            Omninity Operator
          </p>
        </div>
      </div>

      <StepIndicator currentIndex={stepIndex} total={STEPS.length} />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">
            {step === "welcome" && "Welcome to Omninity Operator"}
            {step === "identity" && "Tell us a little about you"}
            {step === "useCase" && "What will you use it for?"}
            {step === "model" && "Pick your model"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <ErrorBanner error={upsert.error ?? hardwareQuery.error ?? null} />

          {step === "welcome" ? (
            <WelcomeStep />
          ) : null}

          {step === "identity" ? (
            <IdentityStep
              displayName={displayName}
              setDisplayName={setDisplayName}
              userType={userType}
              setUserType={setUserType}
            />
          ) : null}

          {step === "useCase" ? (
            <UseCaseStep useCase={useCase} setUseCase={setUseCase} />
          ) : null}

          {step === "model" ? (
            <ModelStep
              hardware={hardware}
              recommendation={recommendation}
              plan={plan}
              minimumSpec={minimumSpec}
              chosenModel={chosenModel}
              onChooseModel={setChosenModel}
              visionMode={visionMode}
              onChangeVisionMode={setVisionMode}
              loading={hardwareQuery.isLoading || recommendedQuery.isLoading}
              installProgress={installProgress}
              onStartInstall={() => setInstallProgress(0)}
            />
          ) : null}

          <div className="flex items-center justify-between pt-2">
            <Button
              variant="ghost"
              onClick={goBack}
              disabled={stepIndex === 0 || upsert.isPending}
              data-testid="button-wizard-back"
            >
              Back
            </Button>

            {step === "welcome" ? (
              <Button
                onClick={() => goNext()}
                data-testid="button-wizard-next-welcome"
              >
                Get started
              </Button>
            ) : null}

            {step === "identity" ? (
              <Button
                onClick={() =>
                  goNext({
                    ...(displayName.trim().length > 0
                      ? { displayName: displayName.trim() }
                      : {}),
                    ...(userType ? { userType } : {}),
                  })
                }
                disabled={!userType || displayName.trim().length === 0 || upsert.isPending}
                data-testid="button-wizard-next-identity"
              >
                Continue
              </Button>
            ) : null}

            {step === "useCase" ? (
              <Button
                onClick={() => goNext(useCase ? { useCase } : {})}
                disabled={!useCase || upsert.isPending}
                data-testid="button-wizard-next-usecase"
              >
                Continue
              </Button>
            ) : null}

            {step === "model" ? (
              <Button
                onClick={completeWizard}
                disabled={
                  upsert.isPending ||
                  hardwareQuery.isLoading ||
                  // Hard gate: when the host fails the minimum-spec check
                  // we refuse to complete onboarding so the user never
                  // ends up on a broken install.
                  (minimumSpec !== null && !minimumSpec.meetsMinimum)
                }
                data-testid="button-wizard-finish"
              >
                {upsert.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Finishing…
                  </>
                ) : (
                  <>
                    <Check className="mr-2 h-3.5 w-3.5" />
                    Open Operator
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepIndicator({
  currentIndex,
  total,
}: {
  currentIndex: number;
  total: number;
}) {
  const pct = useMemo(
    () => Math.round(((currentIndex + 1) / total) * 100),
    [currentIndex, total],
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Step {currentIndex + 1} of {total}
        </span>
        <span>{pct}%</span>
      </div>
      <Progress value={pct} className="h-1.5" />
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="space-y-3 text-sm text-foreground">
      <p>
        Omninity Operator is a local-first multi-agent assistant powered by
        Ollama. Your data stays on this machine by default — nothing leaves
        without an explicit approval.
      </p>
      <ul className="space-y-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />
          Local model lifecycle — pull, run, swap from the chat header.
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />
          Six specialised agents — Router, Planner, Executor, Verifier,
          Research, Memory.
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />
          Approval gates on every external write, spend, and data egress.
        </li>
      </ul>
    </div>
  );
}

function IdentityStep({
  displayName,
  setDisplayName,
  userType,
  setUserType,
}: {
  displayName: string;
  setDisplayName: (v: string) => void;
  userType: UserType | null;
  setUserType: (v: UserType) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="wizard-name">Display name</Label>
        <Input
          id="wizard-name"
          data-testid="input-wizard-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="What should the agents call you?"
          maxLength={120}
        />
      </div>

      <div className="space-y-2">
        <Label>Who's this for?</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {USER_TYPES.map((opt) => {
            const selected = userType === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setUserType(opt.value)}
                data-testid={`button-user-type-${opt.value}`}
                className={cn(
                  "rounded-md border p-3 text-left transition-colors hover-elevate active-elevate-2",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card",
                )}
              >
                <p className="text-sm font-medium text-foreground">
                  {opt.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {opt.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UseCaseStep({
  useCase,
  setUseCase,
}: {
  useCase: UseCase | null;
  setUseCase: (v: UseCase) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Pick a primary focus — we'll tailor the starter tasks.</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {USE_CASES.map((opt) => {
          const selected = useCase === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setUseCase(opt.value)}
              data-testid={`button-use-case-${opt.value}`}
              className={cn(
                "rounded-md border p-3 text-left transition-colors hover-elevate active-elevate-2",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card",
              )}
            >
              <p className="text-sm font-medium text-foreground">
                {opt.title}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {opt.description}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModelStep({
  hardware,
  recommendation,
  plan,
  minimumSpec,
  chosenModel,
  onChooseModel,
  visionMode,
  onChangeVisionMode,
  loading,
  installProgress,
  onStartInstall,
}: {
  hardware: HardwareProfile | null;
  recommendation: ModelRecommendation | null;
  plan: ModelInstallPlan | null;
  minimumSpec: MinimumSpecVerdict | null;
  chosenModel: string | null;
  onChooseModel: (id: string) => void;
  visionMode: SelectModelRequestVisionLifecycleMode;
  onChangeVisionMode: (mode: SelectModelRequestVisionLifecycleMode) => void;
  loading: boolean;
  installProgress: number | null;
  onStartInstall: () => void;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Detecting hardware…
      </p>
    );
  }

  // Hard min-spec gate — no chooser, no install button. The wizard's
  // "Open Operator" CTA is disabled by `belowMinSpec` (see SetupWizard)
  // so the user can't push past this screen with a degraded install.
  if (minimumSpec && !minimumSpec.meetsMinimum) {
    return <MinSpecScreen hardware={hardware} minimumSpec={minimumSpec} />;
  }

  // Build the unique chooser list from plan.primary + plan.alternatives.
  const choices: ReadonlyArray<ModelCatalogueEntry> = plan
    ? [plan.primary, ...plan.alternatives]
    : [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-card p-3">
          <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <HardDrive className="h-3 w-3" /> Memory
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {hardware ? formatBytes(hardware.totalRamBytes) : "—"} total
          </p>
          {hardware ? (
            <p className="text-xs text-muted-foreground">
              {formatBytes(hardware.freeRamBytes)} free
            </p>
          ) : null}
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <Cpu className="h-3 w-3" /> CPU
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {hardware ? `${hardware.cpuCount} cores` : "—"}
          </p>
          {hardware ? (
            <p className="truncate text-xs text-muted-foreground">
              {hardware.arch}
              {hardware.appleSilicon ? " · Apple Silicon" : ""}
            </p>
          ) : null}
        </div>
      </div>

      {plan ? (
        <>
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium text-foreground">
                Recommended for your hardware
              </p>
              <Badge
                variant="outline"
                className="ml-auto text-[10px] uppercase"
                data-testid="badge-tier"
              >
                {plan.tier}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{plan.reason}</p>
          </div>

          <div className="space-y-2">
            {choices.map((m) => {
              const selected = chosenModel === m.id;
              const isRecommended = m.id === plan.primary.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChooseModel(m.id)}
                  className={cn(
                    "w-full rounded-md border p-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30",
                  )}
                  data-testid={`button-choose-model-${m.id}`}
                >
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {m.displayName}
                    </p>
                    {isRecommended ? (
                      <Badge
                        variant="secondary"
                        className="text-[10px] uppercase"
                      >
                        Recommended
                      </Badge>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatBytes(m.sizeBytes)} · {formatBytes(m.ramRequiredBytes)} RAM
                    </span>
                    {selected ? (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.tradeoff}
                  </p>
                </button>
              );
            })}
          </div>

          {plan.companions.length > 0 ? (
            <div className="rounded-md border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-xs font-medium text-foreground">
                  Vision companion bundled:{" "}
                  <span className="font-mono">
                    {plan.companions[0]?.displayName}
                  </span>
                </p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Loaded on demand and unloaded after idle to free RAM.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {(["aggressive", "balanced", "warm"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onChangeVisionMode(mode)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-wide transition-colors",
                      visionMode === mode
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-muted/40",
                    )}
                    data-testid={`button-vision-mode-${mode}`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
            <p>
              Total install size:{" "}
              <span className="font-medium text-foreground">
                {formatBytes(plan.totalDownloadBytes)}
              </span>{" "}
              · Approx RAM at runtime:{" "}
              <span className="font-medium text-foreground">
                {formatBytes(plan.totalRamBytes)}
              </span>
            </p>
          </div>

          {installProgress === null ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onStartInstall}
              data-testid="button-install-model"
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Pull model
            </Button>
          ) : (
            <div className="space-y-1.5">
              <Progress value={installProgress} className="h-1.5" />
              <p className="text-xs text-muted-foreground">
                {installProgress >= 100
                  ? "Model ready."
                  : `Pulling ${chosenModel ?? plan.primary.id} — ${installProgress}%`}
              </p>
            </div>
          )}
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">
        You can swap models any time from Settings. Skipping the pull is fine —
        you can install later.
      </p>
    </div>
  );
}

function MinSpecScreen({
  hardware,
  minimumSpec,
}: {
  hardware: HardwareProfile | null;
  minimumSpec: MinimumSpecVerdict;
}) {
  // Hard gate. We deliberately do NOT offer a "continue with the smallest
  // model" path here — installing a configuration that can't actually run
  // primary + bundled vision wastes the user's bandwidth and produces a
  // broken first-run experience. The setup wizard's "Open Operator"
  // button is disabled while this screen is rendered (see ModelStep
  // gating in SetupWizard) so the user is funnelled toward the upgrade
  // path or running OP on a different machine.
  return (
    <div className="space-y-3" data-testid="min-spec-screen">
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            This Mac/PC doesn&apos;t meet the minimum spec
          </p>
          <p className="text-xs text-muted-foreground">{minimumSpec.message}</p>
        </div>
      </div>
      <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        <p>
          Detected RAM:{" "}
          <span className="font-medium text-foreground">
            {hardware ? formatBytes(hardware.totalRamBytes) : "—"}
          </span>{" "}
          · Required:{" "}
          <span className="font-medium text-foreground">
            {formatBytes(minimumSpec.minimumRamBytes)}
          </span>
        </p>
        <p className="mt-1">
          OP installs a primary chat model alongside Moondream 2 (vision) so
          desktop control works out of the box. Both have to fit in RAM at
          the same time.
        </p>
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">What to do next</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>Run setup again on a host with more RAM (16 GB+ recommended).</li>
          <li>
            Or upgrade this machine&apos;s memory and re-run first-run setup
            from the Settings menu.
          </li>
        </ul>
      </div>
    </div>
  );
}
