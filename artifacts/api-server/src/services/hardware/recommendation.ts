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
 * Vision (Moondream 2) is ALWAYS bundled with the primary — that is a
 * product-level invariant of OP, not a per-host optimisation. If no primary
 * fits while reserving RAM for the vision companion + the system baseline,
 * we return `null` so the caller surfaces the minimum-spec gate. We never
 * silently drop vision and continue with a degraded install: a host that
 * can't run primary + vision + OS reserve fails the minimum-spec check.
 */
export function buildModelInstallPlan(
  hardware: HardwareProfile,
): ModelInstallPlan | null {
  const vision = getDefaultVision();
  if (!vision) {
    // The catalogue must always ship a vision companion — this is a
    // configuration bug, fail fast instead of silently degrading.
    throw new Error(
      "Model catalogue is missing a vision companion (role='vision').",
    );
  }
  const visionRam = vision.ramRequiredBytes;

  const fitting = rankFittingPrimaries(hardware.totalRamBytes, visionRam);
  const primary = chooseRecommendedPrimary(hardware, fitting);
  if (!primary) return null;

  const companions: ModelInstallPlanEntry[] = [
    {
      id: vision.id,
      displayName: vision.displayName,
      role: vision.role,
      sizeBytes: vision.sizeBytes,
      ramRequiredBytes: vision.ramRequiredBytes,
    },
  ];

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
    reason: reasonFor(hardware, primary, true),
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
 * Yes/no verdict the min-spec screen needs.
 *
 * Minimum spec is the smallest primary model + the bundled vision companion
 * + the system RAM reservation. We include vision in the floor because the
 * product invariant is that primary AND vision are installed together — a
 * host that can't run that combined footprint cannot run OP's desktop
 * control surface (vision is required for screen tools), so allowing
 * "minimum spec met" without vision RAM would let users install a
 * configuration that does not actually work.
 */
export function evaluateMinimumSpec(
  hardware: HardwareProfile,
): MinimumSpecVerdict {
  const minimum = getMinimumPrimary();
  const vision = getDefaultVision();
  const visionRam = vision?.ramRequiredBytes ?? 0;
  const minimumRamBytes =
    minimum.ramRequiredBytes + visionRam + SYSTEM_RAM_RESERVATION_BYTES;
  const meets = hardware.totalRamBytes >= minimumRamBytes;
  const visionBlurb = vision ? ` + ${vision.displayName}` : "";
  return {
    meetsMinimum: meets,
    minimumRamBytes,
    detectedRamBytes: hardware.totalRamBytes,
    message: meets
      ? `Host meets the minimum spec (${minimum.displayName}${visionBlurb} fit).`
      : `Below minimum spec — Omninity Operator needs at least ${(
          minimumRamBytes /
          (1024 * 1024 * 1024)
        ).toFixed(1)}GB of RAM to run ${minimum.displayName}${visionBlurb}. Detected ${(
          hardware.totalRamBytes /
          (1024 * 1024 * 1024)
        ).toFixed(1)}GB.`,
  };
}

export { tierForRam, MODEL_CATALOGUE };
