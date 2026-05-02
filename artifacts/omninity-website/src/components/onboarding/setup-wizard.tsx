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
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  useGetModelsCatalogue,
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
import { isFeatureDisabledError } from "@/lib/api-errors";
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
  const recommendedQuery = useGetModelsRecommended({
    query: { retry: false } as never,
  });
  const catalogueQuery = useGetModelsCatalogue({
    query: { retry: false } as never,
  });
  const upsert = useUpsertOnboardingProfile();
  const selectModel = useSelectModel();

  const stepIndex = STEPS.indexOf(step);

  // When the hardware-aware feature flag is off, the four /api/models/*
  // routes return 404 FEATURE_DISABLED. Detect that explicitly so the
  // wizard falls back to the legacy `/onboarding/hardware` recommendation
  // path instead of surfacing the 404 as a generic error banner.
  const featureDisabled =
    isFeatureDisabledError(recommendedQuery.error) ||
    isFeatureDisabledError(catalogueQuery.error);

  const hardware: HardwareProfile | null =
    hardwareQuery.data?.data.hardware ?? null;
  const recommendation: ModelRecommendation | null =
    hardwareQuery.data?.data.recommendation ?? null;

  const plan: ModelInstallPlan | null =
    recommendedQuery.data?.data.plan ?? null;
  const minimumSpec: MinimumSpecVerdict | null =
    recommendedQuery.data?.data.minimumSpec ?? null;
  const catalogue: ReadonlyArray<ModelCatalogueEntry> =
    catalogueQuery.data?.data.items ?? [];

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
          {/* Surface failures from the new recommendation/catalogue routes
              UNLESS they are the documented `FEATURE_DISABLED` 404, which
              the wizard handles via `LegacyModelFallback`. Without this
              banner the model step would silently render with no plan and
              no error after a generic 5xx. */}
          {!featureDisabled ? (
            <ErrorBanner error={recommendedQuery.error} />
          ) : null}
          {!featureDisabled ? (
            <ErrorBanner error={catalogueQuery.error} />
          ) : null}

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
              catalogue={catalogue}
              featureDisabled={featureDisabled}
              chosenModel={chosenModel}
              onChooseModel={setChosenModel}
              visionMode={visionMode}
              onChangeVisionMode={setVisionMode}
              loading={
                hardwareQuery.isLoading ||
                (!featureDisabled && recommendedQuery.isLoading)
              }
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
                  // ends up on a broken install. When the feature flag is
                  // off there is no min-spec verdict — the legacy probe is
                  // permissive and we let the user through.
                  (!featureDisabled &&
                    minimumSpec !== null &&
                    !minimumSpec.meetsMinimum) ||
                  // Block finish when the new recommendation route failed
                  // for a non-FEATURE_DISABLED reason — there is no plan
                  // to install and the legacy fallback path is not active.
                  (!featureDisabled &&
                    !recommendedQuery.isLoading &&
                    plan === null &&
                    recommendedQuery.error !== null)
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

/** Human-friendly axis labels used by the chooser headings. */
const USE_CASE_AXIS_LABELS: Record<
  NonNullable<ModelCatalogueEntry["useCaseAxis"]> | "balanced",
  { title: string; description: string }
> = {
  writing: {
    title: "Best for writing",
    description: "Long-form drafting, editing, and conversational quality.",
  },
  code: {
    title: "Best for code",
    description: "Refactors, code review, tool-use, and structured output.",
  },
  balanced: {
    title: "Best overall — balanced",
    description: "Strong all-rounder for chat, agents, and everyday tasks.",
  },
};

const AXIS_ORDER: ReadonlyArray<keyof typeof USE_CASE_AXIS_LABELS> = [
  "balanced",
  "writing",
  "code",
];

/** Group catalogue entries by `useCaseAxis`, preferring the recommended
 *  primary as the visible representative for its axis. */
function groupChoicesByAxis(
  choices: ReadonlyArray<ModelCatalogueEntry>,
  recommendedId: string | null,
): Array<{
  axis: keyof typeof USE_CASE_AXIS_LABELS;
  pick: ModelCatalogueEntry;
  others: ReadonlyArray<ModelCatalogueEntry>;
}> {
  const byAxis = new Map<
    keyof typeof USE_CASE_AXIS_LABELS,
    Array<ModelCatalogueEntry>
  >();
  for (const m of choices) {
    const axis = (m.useCaseAxis ?? "balanced") as keyof typeof USE_CASE_AXIS_LABELS;
    const list = byAxis.get(axis) ?? [];
    list.push(m);
    byAxis.set(axis, list);
  }
  const out: Array<{
    axis: keyof typeof USE_CASE_AXIS_LABELS;
    pick: ModelCatalogueEntry;
    others: ReadonlyArray<ModelCatalogueEntry>;
  }> = [];
  for (const axis of AXIS_ORDER) {
    const list = byAxis.get(axis);
    if (!list || list.length === 0) continue;
    // Prefer the recommended primary as the visible representative when
    // it lives in this axis; otherwise pick the smallest-RAM entry so the
    // "writing" / "code" suggestions don't default to the heaviest model.
    const sorted = [...list].sort(
      (a, b) => a.ramRequiredBytes - b.ramRequiredBytes,
    );
    const recommended = sorted.find((m) => m.id === recommendedId);
    const pick = recommended ?? sorted[0]!;
    out.push({
      axis,
      pick,
      others: sorted.filter((m) => m.id !== pick.id),
    });
  }
  return out;
}

/** Headroom estimate the power-user catalogue uses to badge each model
 *  as "fits" vs "needs more RAM". Mirrors the recommendation engine's
 *  arithmetic (primary + vision + system reserve) without re-importing
 *  server-only constants — the catalogue API already exposes vision RAM. */
function estimateFits(
  primary: ModelCatalogueEntry,
  vision: ModelCatalogueEntry | null,
  totalRamBytes: number,
): boolean {
  const SYSTEM_RESERVE = 2 * 1024 * 1024 * 1024;
  const need =
    primary.ramRequiredBytes +
    (vision ? vision.ramRequiredBytes : 0) +
    SYSTEM_RESERVE;
  return need <= totalRamBytes;
}

function ModelStep({
  hardware,
  recommendation,
  plan,
  minimumSpec,
  catalogue,
  featureDisabled,
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
  catalogue: ReadonlyArray<ModelCatalogueEntry>;
  featureDisabled: boolean;
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

  // Feature-flag fallback: the new recommendation engine returned 404
  // FEATURE_DISABLED. Render the legacy hardware probe + single-line
  // recommendation so onboarding still finishes; the user just doesn't
  // see the axis chooser, vision lifecycle controls, or power-user mode.
  if (featureDisabled) {
    return (
      <LegacyModelFallback
        hardware={hardware}
        recommendation={recommendation}
        chosenModel={chosenModel}
        onChooseModel={onChooseModel}
        installProgress={installProgress}
        onStartInstall={onStartInstall}
      />
    );
  }

  // Hard min-spec gate — no chooser, no install button. The wizard's
  // "Open Operator" CTA is disabled by `belowMinSpec` (see SetupWizard)
  // so the user can't push past this screen with a degraded install.
  if (minimumSpec && !minimumSpec.meetsMinimum) {
    return <MinSpecScreen hardware={hardware} minimumSpec={minimumSpec} />;
  }

  const recommendedId = plan?.primary.id ?? null;
  // Build the unique chooser list from plan.primary + plan.alternatives,
  // then group by use-case axis so the user picks by intent rather than
  // by raw model name (Task #64 "Done looks like": labelled options).
  const choices: ReadonlyArray<ModelCatalogueEntry> = plan
    ? [plan.primary, ...plan.alternatives]
    : [];
  const groups = groupChoicesByAxis(choices, recommendedId);

  return (
    <div className="space-y-4">
      <HardwarePanels hardware={hardware} />

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

          <div className="space-y-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Choose another
            </p>
            {groups.map(({ axis, pick }) => {
              const selected = chosenModel === pick.id;
              const isRecommended = pick.id === recommendedId;
              const label = USE_CASE_AXIS_LABELS[axis];
              return (
                <button
                  key={axis}
                  type="button"
                  onClick={() => onChooseModel(pick.id)}
                  className={cn(
                    "w-full rounded-md border p-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30",
                  )}
                  data-testid={`button-choose-axis-${axis}`}
                >
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {label.title}
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
                      {formatBytes(pick.sizeBytes)} ·{" "}
                      {formatBytes(pick.ramRequiredBytes)} RAM
                    </span>
                    {selected ? (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {label.description}
                  </p>
                  <p className="mt-1 text-[11px] font-mono text-muted-foreground/80">
                    {pick.displayName}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pick.tradeoff}
                  </p>
                </button>
              );
            })}
          </div>

          <PowerUserCatalogue
            catalogue={catalogue}
            hardware={hardware}
            chosenModel={chosenModel}
            recommendedId={recommendedId}
            onChooseModel={onChooseModel}
          />

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
              size="sm"
              onClick={onStartInstall}
              data-testid="button-install-model"
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Install recommended
            </Button>
          ) : (
            <div className="space-y-1.5">
              <Progress value={installProgress} className="h-1.5" />
              <p className="text-xs text-muted-foreground">
                {installProgress >= 100
                  ? "Model ready."
                  : `Installing ${chosenModel ?? plan.primary.id} — ${installProgress}%`}
              </p>
            </div>
          )}
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">
        You can swap models any time from Settings. Skipping the install is
        fine — you can pull it later.
      </p>
    </div>
  );
}

function HardwarePanels({ hardware }: { hardware: HardwareProfile | null }) {
  return (
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
  );
}

function PowerUserCatalogue({
  catalogue,
  hardware,
  chosenModel,
  recommendedId,
  onChooseModel,
}: {
  catalogue: ReadonlyArray<ModelCatalogueEntry>;
  hardware: HardwareProfile | null;
  chosenModel: string | null;
  recommendedId: string | null;
  onChooseModel: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const primaries = catalogue.filter((m) => m.role === "primary");
  const vision = catalogue.find((m) => m.role === "vision") ?? null;
  if (primaries.length === 0) return null;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/30"
        data-testid="button-toggle-power-user"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        Power user: see all models
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          {primaries.length} primaries · vision bundled
        </span>
      </button>
      {open ? (
        <div className="border-t border-border p-2">
          <p className="px-1 pb-2 text-[11px] text-muted-foreground">
            The bundled vision companion (
            <span className="font-mono">{vision?.displayName ?? "—"}</span>) is
            loaded on demand alongside whichever primary you pick. Models
            below are tagged by whether they fit your detected hardware.
          </p>
          <div className="space-y-1.5">
            {primaries.map((m) => {
              const fits = hardware
                ? estimateFits(m, vision, hardware.totalRamBytes)
                : true;
              const selected = chosenModel === m.id;
              const isRecommended = m.id === recommendedId;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChooseModel(m.id)}
                  className={cn(
                    "w-full rounded-md border p-2.5 text-left text-xs transition-colors",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30",
                  )}
                  data-testid={`button-choose-model-${m.id}`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-foreground">{m.id}</span>
                    {isRecommended ? (
                      <Badge variant="secondary" className="text-[9px] uppercase">
                        Recommended
                      </Badge>
                    ) : null}
                    <Badge
                      variant={fits ? "outline" : "destructive"}
                      className="text-[9px] uppercase"
                    >
                      {fits ? "Fits" : "Needs more RAM"}
                    </Badge>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {formatBytes(m.sizeBytes)} ·{" "}
                      {formatBytes(m.ramRequiredBytes)} RAM
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {m.displayName} · {m.capabilities.join(" · ")}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LegacyModelFallback({
  hardware,
  recommendation,
  chosenModel,
  onChooseModel,
  installProgress,
  onStartInstall,
}: {
  hardware: HardwareProfile | null;
  recommendation: ModelRecommendation | null;
  chosenModel: string | null;
  onChooseModel: (id: string) => void;
  installProgress: number | null;
  onStartInstall: () => void;
}) {
  // Auto-pick the legacy recommendation as the chosen model so "Open
  // Operator" can complete the wizard even when the new chooser is off.
  useEffect(() => {
    if (chosenModel === null && recommendation) {
      onChooseModel(recommendation.model);
    }
  }, [chosenModel, recommendation, onChooseModel]);

  return (
    <div className="space-y-4">
      <HardwarePanels hardware={hardware} />
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5" />
        <p>
          Hardware-aware recommendations are turned off on this server. Falling
          back to the basic recommendation — you can swap models any time from
          Settings.
        </p>
      </div>
      {recommendation ? (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">
              Recommended model
            </p>
            <Badge variant="outline" className="ml-auto text-[10px] uppercase">
              {recommendation.tier}
            </Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {recommendation.model} ·{" "}
            {formatBytes(recommendation.sizeBytes)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {recommendation.reason}
          </p>
          {installProgress === null ? (
            <Button
              size="sm"
              className="mt-3"
              onClick={onStartInstall}
              data-testid="button-install-model"
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Install recommended
            </Button>
          ) : (
            <div className="mt-3 space-y-1.5">
              <Progress value={installProgress} className="h-1.5" />
              <p className="text-xs text-muted-foreground">
                {installProgress >= 100
                  ? "Model ready."
                  : `Installing ${chosenModel ?? recommendation.model} — ${installProgress}%`}
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">
          Hardware probe still loading…
        </p>
      )}
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
