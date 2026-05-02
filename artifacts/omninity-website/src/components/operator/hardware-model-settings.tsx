/**
 * Settings → Models card backed by the hardware-aware recommendation engine
 * (Task #64 step 6). Mirrors the onboarding chooser so a user can swap their
 * primary model later without re-running the wizard, plus surfaces the two
 * post-onboarding controls the wizard does not own:
 *   - "Re-detect hardware" — the user upgraded RAM, swapped machines, etc.
 *   - Vision idle-timeout policy — aggressive on RAM-constrained hosts,
 *     warm on workstations that use desktop control frequently.
 *
 * When `feature.hardware_aware_recommendation` is off the four backing
 * routes return 404 FEATURE_DISABLED. The card detects that case and shows
 * a graceful notice rather than an error banner — the rest of Settings keeps
 * working unaffected.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  HardDrive,
  Loader2,
  RotateCcw,
  Wand2,
} from "lucide-react";
import {
  useGetModelsCatalogue,
  useGetModelsRecommended,
  useRedetectHardware,
  useSelectModel,
  type HardwareProfile,
  type ModelCatalogueEntry,
  type ModelInstallPlan,
  type SelectModelRequestVisionLifecycleMode,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorBanner } from "@/components/operator/error-banner";
import { isFeatureDisabledError } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

const VISION_MODES: ReadonlyArray<{
  value: SelectModelRequestVisionLifecycleMode;
  label: string;
  description: string;
}> = [
  {
    value: "aggressive",
    label: "Aggressive",
    description: "Unload vision quickly. Best for 8GB hosts.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Default. Unloads after a few minutes idle.",
  },
  {
    value: "warm",
    label: "Warm",
    description: "Keep vision resident for snappier desktop control.",
  },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

const USE_CASE_LABELS: Record<
  "writing" | "code" | "balanced",
  { title: string; description: string }
> = {
  writing: {
    title: "Best for writing",
    description: "Long-form drafting, editing, conversational quality.",
  },
  code: {
    title: "Best for code",
    description: "Refactors, code review, structured tool-use.",
  },
  balanced: {
    title: "Best overall — balanced",
    description: "Strong all-rounder for chat, agents, and everyday tasks.",
  },
};

function pickAxisRepresentatives(
  plan: ModelInstallPlan,
): Array<{
  axis: "writing" | "code" | "balanced";
  entry: ModelCatalogueEntry;
}> {
  const choices = [plan.primary, ...plan.alternatives];
  const byAxis = new Map<"writing" | "code" | "balanced", ModelCatalogueEntry>();
  for (const m of choices) {
    const axis = (m.useCaseAxis ?? "balanced") as
      | "writing"
      | "code"
      | "balanced";
    const current = byAxis.get(axis);
    if (!current || m.ramRequiredBytes < current.ramRequiredBytes) {
      byAxis.set(axis, m);
    }
  }
  // Prefer the recommended primary in its own axis so the user always sees
  // the engine's first pick rather than a smaller stand-in.
  const recommendedAxis = (plan.primary.useCaseAxis ?? "balanced") as
    | "writing"
    | "code"
    | "balanced";
  byAxis.set(recommendedAxis, plan.primary);
  const order: ReadonlyArray<"balanced" | "writing" | "code"> = [
    "balanced",
    "writing",
    "code",
  ];
  return order
    .filter((axis) => byAxis.has(axis))
    .map((axis) => ({ axis, entry: byAxis.get(axis)! }));
}

export function HardwareModelSettings() {
  const qc = useQueryClient();
  const recommended = useGetModelsRecommended({
    query: { retry: false } as never,
  });
  const catalogue = useGetModelsCatalogue({
    query: { retry: false } as never,
  });
  const select = useSelectModel({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries();
      },
    },
  });
  const redetect = useRedetectHardware({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries();
      },
    },
  });

  const featureDisabled =
    isFeatureDisabledError(recommended.error) ||
    isFeatureDisabledError(catalogue.error);

  const data = recommended.data?.data;
  const hardware: HardwareProfile | null = data?.hardware ?? null;
  const plan: ModelInstallPlan | null = data?.plan ?? null;
  const preferences = data?.preferences ?? null;
  const curated: ReadonlyArray<ModelCatalogueEntry> =
    catalogue.data?.data.items ?? [];
  // Power-user view: full Ollama library returned by the catalogue route
  // alongside the curated set. The recommendation engine doesn't see this
  // list — it's only for users who want to pick something outside the
  // engine's curation.
  const library: ReadonlyArray<ModelCatalogueEntry> =
    catalogue.data?.data.library ?? [];

  const [visionMode, setVisionMode] =
    useState<SelectModelRequestVisionLifecycleMode>("balanced");
  useEffect(() => {
    if (preferences?.visionLifecycle?.mode) {
      setVisionMode(
        preferences.visionLifecycle.mode as SelectModelRequestVisionLifecycleMode,
      );
    }
  }, [preferences]);

  const currentPrimary = preferences?.primaryModel ?? plan?.primary.id ?? null;
  const axisGroups = useMemo(
    () => (plan ? pickAxisRepresentatives(plan) : []),
    [plan],
  );

  const onSwap = (id: string) => {
    select.mutate({
      data: { primaryModel: id, visionLifecycleMode: visionMode },
    });
  };
  const onChangeVision = (mode: SelectModelRequestVisionLifecycleMode) => {
    setVisionMode(mode);
    if (currentPrimary) {
      select.mutate({
        data: { primaryModel: currentPrimary, visionLifecycleMode: mode },
      });
    }
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">Models</CardTitle>
        <CardDescription className="text-xs">
          Currently active primary model, bundled vision companion, and the
          hardware-aware controls that drove the recommendation. Swapping here
          is equivalent to re-running the onboarding chooser — no wizard
          replay required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {featureDisabled ? (
          <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Hardware-aware recommendations are disabled on this server
            (
            <span className="font-mono">
              feature.hardware_aware_recommendation
            </span>
            ). The legacy single-model recommendation is still used during
            onboarding, and you can pull any Ollama model by name from the
            "Pull custom model" card below.
          </p>
        ) : (
          <>
            {recommended.isLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Detecting hardware…
              </p>
            ) : null}
            <ErrorBanner error={recommended.error} />
            <ErrorBanner error={select.error} />
            <ErrorBanner error={redetect.error} />

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
                    {formatBytes(hardware.freeRamBytes)} free · tier{" "}
                    <span className="font-mono">{hardware.tier}</span>
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

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => redetect.mutate(undefined as never)}
                disabled={redetect.isPending}
                data-testid="button-redetect-hardware"
              >
                {redetect.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 h-3 w-3" />
                )}
                Re-detect hardware
              </Button>
              <p className="text-xs text-muted-foreground">
                Use this after upgrading RAM or swapping machines.
              </p>
            </div>

            {plan ? (
              <>
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                  <div className="flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">
                      Currently active:{" "}
                      <span className="font-mono">{currentPrimary}</span>
                    </p>
                    <Badge
                      variant="outline"
                      className="ml-auto text-[10px] uppercase"
                    >
                      {plan.tier}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plan.reason}
                  </p>
                </div>

                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Swap to another
                  </p>
                  {axisGroups.map(({ axis, entry }) => {
                    const selected = currentPrimary === entry.id;
                    const label = USE_CASE_LABELS[axis];
                    return (
                      <button
                        key={axis}
                        type="button"
                        onClick={() => onSwap(entry.id)}
                        disabled={select.isPending}
                        className={cn(
                          "w-full rounded-md border p-3 text-left transition-colors",
                          selected
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/30",
                        )}
                        data-testid={`button-swap-axis-${axis}`}
                      >
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {label.title}
                          </p>
                          {selected ? (
                            <Badge
                              variant="secondary"
                              className="text-[10px] uppercase"
                            >
                              Active
                            </Badge>
                          ) : null}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {formatBytes(entry.sizeBytes)} ·{" "}
                            {formatBytes(entry.ramRequiredBytes)} RAM
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {label.description}
                        </p>
                        <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                          {entry.displayName}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {entry.tradeoff}
                        </p>
                      </button>
                    );
                  })}
                </div>

                <PowerUserLibrary
                  curated={curated}
                  library={library}
                  hardware={hardware}
                  currentPrimary={currentPrimary}
                  recommendedId={plan.primary.id}
                  onSwap={onSwap}
                  busy={select.isPending}
                />

                {plan.companions.length > 0 ? (
                  <div className="rounded-md border border-border bg-card p-3">
                    <div className="flex items-center gap-2">
                      <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-xs font-medium text-foreground">
                        Vision companion:{" "}
                        <span className="font-mono">
                          {plan.companions[0]?.displayName}
                        </span>
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Loaded on demand for desktop control. Choose how
                      eagerly the runtime unloads it after idle:
                    </p>
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
                      {VISION_MODES.map((mode) => {
                        const active = visionMode === mode.value;
                        return (
                          <button
                            key={mode.value}
                            type="button"
                            onClick={() => onChangeVision(mode.value)}
                            disabled={select.isPending}
                            className={cn(
                              "rounded-md border px-2 py-1.5 text-left transition-colors",
                              active
                                ? "border-primary bg-primary/10"
                                : "border-border hover:bg-muted/30",
                            )}
                            data-testid={`button-vision-mode-${mode.value}`}
                          >
                            <p
                              className={cn(
                                "text-xs font-medium",
                                active ? "text-primary" : "text-foreground",
                              )}
                            >
                              {mode.label}
                            </p>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              {mode.description}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </>
            ) : hardware && !recommended.isLoading ? (
              <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                No model in the catalogue fits this hardware. See the
                minimum-spec screen in onboarding for the upgrade path.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const SYSTEM_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

function fitsHost(
  primary: ModelCatalogueEntry,
  vision: ModelCatalogueEntry | null,
  totalRamBytes: number,
): boolean {
  const need =
    primary.ramRequiredBytes +
    (vision ? vision.ramRequiredBytes : 0) +
    SYSTEM_RESERVE_BYTES;
  return need <= totalRamBytes;
}

function PowerUserLibrary({
  curated,
  library,
  hardware,
  currentPrimary,
  recommendedId,
  onSwap,
  busy,
}: {
  curated: ReadonlyArray<ModelCatalogueEntry>;
  library: ReadonlyArray<ModelCatalogueEntry>;
  hardware: HardwareProfile | null;
  currentPrimary: string | null;
  recommendedId: string | null;
  onSwap: (id: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  // De-dupe by id — curated and library may overlap (e.g. llama3.1:8b
  // appears in both). Curated comes first so familiar entries stay near
  // the top of the list.
  const merged: ReadonlyArray<ModelCatalogueEntry> = (() => {
    const seen = new Set<string>();
    const out: ModelCatalogueEntry[] = [];
    for (const m of [...curated, ...library]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  })();
  const primaries = merged.filter((m) => m.role === "primary");
  const visions = merged.filter((m) => m.role === "vision");
  const bundledVision =
    curated.find((m) => m.role === "vision") ?? visions[0] ?? null;
  if (primaries.length === 0) return null;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/30"
        data-testid="button-settings-toggle-power-user"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        Power user: see all models
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          {primaries.length} primaries · {visions.length} vision
        </span>
      </button>
      {open ? (
        <div className="border-t border-border p-2">
          <p className="px-1 pb-2 text-[11px] text-muted-foreground">
            The full Ollama library is below. Picking a non-curated model
            here swaps your primary immediately and keeps the bundled
            vision companion (
            <span className="font-mono">
              {bundledVision?.displayName ?? "—"}
            </span>
            ).
          </p>
          <div className="space-y-1.5">
            {primaries.map((m) => {
              const fits = hardware
                ? fitsHost(m, bundledVision, hardware.totalRamBytes)
                : true;
              const isCurrent = currentPrimary === m.id;
              const isRecommended = m.id === recommendedId;
              const isCurated = curated.some((c) => c.id === m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onSwap(m.id)}
                  disabled={busy}
                  className={cn(
                    "w-full rounded-md border p-2.5 text-left text-xs transition-colors",
                    isCurrent
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/30",
                  )}
                  data-testid={`button-settings-swap-${m.id}`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-foreground">{m.id}</span>
                    {isCurrent ? (
                      <Badge
                        variant="secondary"
                        className="text-[9px] uppercase"
                      >
                        Active
                      </Badge>
                    ) : null}
                    {isRecommended && !isCurrent ? (
                      <Badge
                        variant="secondary"
                        className="text-[9px] uppercase"
                      >
                        Recommended
                      </Badge>
                    ) : null}
                    {isCurated && !isRecommended && !isCurrent ? (
                      <Badge variant="outline" className="text-[9px] uppercase">
                        Curated
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
