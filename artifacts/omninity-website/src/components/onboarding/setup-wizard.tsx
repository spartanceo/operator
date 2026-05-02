import { useEffect, useMemo, useState } from "react";
import {
  Cpu,
  Sparkles,
  Download,
  Check,
  Loader2,
  HardDrive,
  Wand2,
} from "lucide-react";
import {
  useGetOnboardingHardware,
  useUpsertOnboardingProfile,
  type HardwareProfile,
  type ModelRecommendation,
  type OnboardingProfile,
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
  const upsert = useUpsertOnboardingProfile();

  const stepIndex = STEPS.indexOf(step);

  const hardware: HardwareProfile | null =
    hardwareQuery.data?.data.hardware ?? null;
  const recommendation: ModelRecommendation | null =
    hardwareQuery.data?.data.recommendation ?? null;

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
    upsert.mutate(
      {
        data: {
          completed: true,
          ...(recommendation
            ? { recommendedModel: recommendation.model }
            : {}),
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
              loading={hardwareQuery.isLoading}
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
                disabled={upsert.isPending || hardwareQuery.isLoading}
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
  loading,
  installProgress,
  onStartInstall,
}: {
  hardware: HardwareProfile | null;
  recommendation: ModelRecommendation | null;
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

      {recommendation ? (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">
              Recommended: <span className="font-mono">{recommendation.model}</span>
            </p>
            <Badge
              variant="outline"
              className="ml-auto text-[10px] uppercase"
              data-testid="badge-tier"
            >
              {recommendation.tier}
            </Badge>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {recommendation.reason}
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Approx download size: {formatBytes(recommendation.sizeBytes)}.
          </p>

          {installProgress === null ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={onStartInstall}
              data-testid="button-install-model"
            >
              <Download className="mr-2 h-3.5 w-3.5" />
              Pull model
            </Button>
          ) : (
            <div className="mt-3 space-y-1.5">
              <Progress value={installProgress} className="h-1.5" />
              <p className="text-xs text-muted-foreground">
                {installProgress >= 100
                  ? "Model ready."
                  : `Pulling ${recommendation.model} — ${installProgress}%`}
              </p>
            </div>
          )}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        You can swap models any time from the chat header. Skipping the pull is
        fine — you can install later from Settings.
      </p>
    </div>
  );
}
