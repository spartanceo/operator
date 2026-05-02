/**
 * Pure recommendation engine for hardware-aware model selection (Task #64).
 *
 * Given a `HardwareProfile` and the (data-only) catalogue, produces a
 * `ModelInstallPlan` with:
 *  - the recommended primary model (best fit for the tier),
 *  - bundled vision companion (Moondream2) when there is RAM headroom,
 *  - 2-3 alternatives keyed off the use-case axes (writing / code / balanced),
 *  - a `fitsHardware` flag that drives the minimum-spec screen,
 *  - a download-size and RAM total for the install screen progress UI.
 *
 * No I/O, no DB, no `os.*` calls — every input is on the function signature
 * so the engine is trivially unit-testable on any host.
 */
import type {
  HardwareProfile,
  HardwareTierKey,
  ModelCatalogueEntry,
  ModelInstallPlan,
  ModelInstallPlanEntry,
  MinimumSpecVerdict,
  ModelRecommendation,
} from "@workspace/types";

import {
  MODEL_CATALOGUE,
  SYSTEM_RAM_RESERVATION_BYTES,
  getDefaultVision,
  getMinimumPrimary,
  tierForRam,
} from "./catalogue";

/** Numeric ordering of the tier labels (low=0 … pro=3). */
const TIER_ORDER: Record<HardwareTierKey, number> = {
  low: 0,
  mid: 1,
  high: 2,
  pro: 3,
};

/**
 * RAM available to a primary model after reserving headroom for the OS
 * baseline and (optionally) the resident vision companion.
 */
function availableRamForPrimary(
  totalRamBytes: number,
  visionRamBytes: number,
): number {
  return Math.max(
    0,
    totalRamBytes - SYSTEM_RAM_RESERVATION_BYTES - visionRamBytes,
  );
}

/**
 * Filter primary models that physically fit on the host given current
 * vision-companion overhead. Sorted by tier desc (best first) then by
 * RAM cost desc — i.e. the most capable model that fits comes first.
 */
function rankFittingPrimaries(
  totalRamBytes: number,
  visionRamBytes: number,
): ModelCatalogueEntry[] {
  const headroom = availableRamForPrimary(totalRamBytes, visionRamBytes);
  // tier-review: bounded — filter+sort over the static catalogue (≤ a few
  // dozen entries). No external input governs size.
  return MODEL_CATALOGUE.filter(
    (m) => m.role === "primary" && m.ramRequiredBytes <= headroom,
  ).sort((a, b) => {
    const tierDelta = TIER_ORDER[b.minTier] - TIER_ORDER[a.minTier];
    if (tierDelta !== 0) return tierDelta;
    return b.ramRequiredBytes - a.ramRequiredBytes;
  });
}

function chooseRecommendedPrimary(
  hardware: HardwareProfile,
  fitting: ReadonlyArray<ModelCatalogueEntry>,
): ModelCatalogueEntry | null {
  if (fitting.length === 0) return null;
  // Prefer the highest-tier model whose `minTier` matches or undershoots
  // the host's tier — never recommend a model labelled `pro` to a `mid`
  // host even if RAM technically allows it (avoids slow inference).
  const hostTierIdx = TIER_ORDER[hardware.tier];
  const tierFit = fitting.find((m) => TIER_ORDER[m.minTier] <= hostTierIdx);
  return tierFit ?? fitting[0] ?? null;
}

/**
 * Pick best-of-axis alternatives — one per `useCaseAxis` (writing / code /
 * balanced). The recommended model is excluded so the chooser shows
 * genuine alternatives rather than a duplicate.
 */
function pickAlternatives(
  fitting: ReadonlyArray<ModelCatalogueEntry>,
  recommendedId: string,
): ModelCatalogueEntry[] {
  const seenAxes = new Set<string>();
  const out: ModelCatalogueEntry[] = [];
  for (const m of fitting) {
    if (m.id === recommendedId) continue;
    const axis = m.useCaseAxis ?? "balanced";
    if (seenAxes.has(axis)) continue;
    seenAxes.add(axis);
    out.push(m);
    if (out.length >= 3) break;
  }
  return out;
}

function reasonFor(
  hardware: HardwareProfile,
  primary: ModelCatalogueEntry,
  visionFits: boolean,
): string {
  const ramGb = (hardware.totalRamBytes / (1024 * 1024 * 1024)).toFixed(1);
  const tierBlurb = `Detected ${ramGb}GB RAM (${hardware.tier} tier)`;
  const visionBlurb = visionFits
    ? " — Moondream 2 vision will load on demand"
    : " — vision companion skipped to keep RAM headroom";
  return `${tierBlurb}: ${primary.displayName} is the best fit${visionBlurb}.`;
}

/**
 * The richer, plan-shaped recommendation introduced by Task #64.
 *
 * If no primary model fits, returns `null` and the caller surfaces the
 * minimum-spec screen (see `evaluateMinimumSpec` below).
 */
export function buildModelInstallPlan(
  hardware: HardwareProfile,
): ModelInstallPlan | null {
  const vision = getDefaultVision();
  const visionRam = vision?.ramRequiredBytes ?? 0;

  // Try with vision first; if that excludes every primary, retry without
  // vision so the user still gets a primary model recommendation and the
  // vision companion is dropped from the bundle.
  let companions: ModelInstallPlanEntry[] = [];
  let fitting = rankFittingPrimaries(hardware.totalRamBytes, visionRam);
  let visionFits = vision !== null && fitting.length > 0;

  if (fitting.length === 0) {
    fitting = rankFittingPrimaries(hardware.totalRamBytes, 0);
    visionFits = false;
  }

  if (visionFits && vision) {
    companions = [
      {
        id: vision.id,
        displayName: vision.displayName,
        role: vision.role,
        sizeBytes: vision.sizeBytes,
        ramRequiredBytes: vision.ramRequiredBytes,
      },
    ];
  }

  const primary = chooseRecommendedPrimary(hardware, fitting);
  if (!primary) return null;

  const alternatives = pickAlternatives(fitting, primary.id);

  const totalDownloadBytes =
    primary.sizeBytes + companions.reduce((s, c) => s + c.sizeBytes, 0);
  const totalRamBytes =
    primary.ramRequiredBytes +
    companions.reduce((s, c) => s + c.ramRequiredBytes, 0);

  return {
    primary,
    companions,
    totalDownloadBytes,
    totalRamBytes,
    fitsHardware: true,
    tier: hardware.tier,
    reason: reasonFor(hardware, primary, visionFits),
    alternatives,
  };
}

/**
 * Back-compat shim for `/api/onboarding/hardware` (Task #8 wire shape).
 *
 * Always returns a `ModelRecommendation` — even on hosts that fail the
 * minimum-spec check we surface the smallest catalogue entry so the UI
 * can keep rendering the chooser. The `fitsHardware` truth lives on
 * `buildModelInstallPlan` for new callers.
 */
export function recommendModelLegacy(
  hardware: HardwareProfile,
): ModelRecommendation {
  const plan = buildModelInstallPlan(hardware);
  const primary = plan?.primary ?? getMinimumPrimary();
  const reason = plan
    ? plan.reason
    : `Below minimum spec — falling back to ${primary.displayName}.`;
  return {
    model: primary.id,
    reason,
    sizeBytes: primary.sizeBytes,
    tier: plan?.tier ?? hardware.tier,
  };
}

/**
 * Yes/no verdict the min-spec screen needs. The threshold is the smallest
 * primary model's resident RAM + the system reservation; below that even
 * the lightest model can't run.
 */
export function evaluateMinimumSpec(
  hardware: HardwareProfile,
): MinimumSpecVerdict {
  const minimum = getMinimumPrimary();
  const minimumRamBytes =
    minimum.ramRequiredBytes + SYSTEM_RAM_RESERVATION_BYTES;
  const meets = hardware.totalRamBytes >= minimumRamBytes;
  return {
    meetsMinimum: meets,
    minimumRamBytes,
    detectedRamBytes: hardware.totalRamBytes,
    message: meets
      ? `Host meets the minimum spec (${minimum.displayName} fits).`
      : `Below minimum spec — Omninity Operator needs at least ${(
          minimumRamBytes /
          (1024 * 1024 * 1024)
        ).toFixed(1)}GB of RAM to run a primary model. Detected ${(
          hardware.totalRamBytes /
          (1024 * 1024 * 1024)
        ).toFixed(1)}GB.`,
  };
}

export { tierForRam, MODEL_CATALOGUE };
