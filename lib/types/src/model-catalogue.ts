/**
 * Hardware-aware model recommendation — shared shapes (Standard 10).
 *
 * The runtime that fills these in lives in
 * `artifacts/api-server/src/services/hardware/*` (Task #64). Putting the
 * shapes in `@workspace/types` lets the frontend, the api-server, and
 * future packages (vision lifecycle in Task #30, model-swap UI) speak the
 * same vocabulary without round-tripping every change through the OpenAPI
 * codegen.
 *
 * `HardwareProfile` and `ModelRecommendation` are the wire shapes used by
 * the existing onboarding hardware probe (Task #8). The richer
 * `ModelInstallPlan`, `ModelCatalogueEntry`, and `VisionModelLifecycleConfig`
 * are introduced here for the catalogue-driven recommendation engine added
 * in Task #64. The new fields on `HardwareProfile` (`gpu`, `osVersion`) are
 * optional so existing callers keep compiling unchanged.
 */

/**
 * Coarse RAM-derived bucket the catalogue maps a primary model to.
 *  - `low`  ≤8GB
 *  - `mid`  ≤16GB
 *  - `high` ≤32GB
 *  - `pro`  >32GB
 *
 * Renamed from `HardwareTier` to avoid colliding with the `HardwareTier`
 * *interface* that already lives in `runtime-modes.ts` (a different concept
 * — runtime mode capability bag, not a tier label).
 */
export type HardwareTierKey = "low" | "mid" | "high" | "pro";

export interface HardwareGpu {
  readonly vendor: string;
  readonly kind: string;
  readonly vramBytes?: number;
}

export interface HardwareProfile {
  readonly platform: string;
  readonly arch: string;
  readonly cpuCount: number;
  readonly cpuModel: string | null;
  readonly totalRamBytes: number;
  readonly freeRamBytes: number;
  readonly appleSilicon: boolean;
  readonly tier: HardwareTierKey;
  readonly detectedAt: string;
  /** Optional GPU snapshot — populated when detection can identify one. */
  readonly gpu?: HardwareGpu | null;
  /** Optional OS release string (`os.release()`). */
  readonly osVersion?: string | null;
}

/**
 * The legacy single-model recommendation (Task #8 / `/onboarding/hardware`).
 * Kept for back-compat with the existing setup-wizard hardware probe.
 */
export interface ModelRecommendation {
  readonly model: string;
  readonly reason: string;
  readonly sizeBytes: number;
  readonly tier: HardwareTierKey;
}

/** What a model in the catalogue is good at. */
export type ModelCapability =
  | "writing"
  | "code"
  | "agent"
  | "general"
  | "reasoning"
  | "vision";

/** Slot the model occupies in the install plan. */
export type ModelRole = "primary" | "vision" | "embedding";

/** Three preset "alternative" axes the chooser surfaces in onboarding. */
export type ModelUseCaseAxis = "writing" | "code" | "balanced";

export interface ModelCatalogueEntry {
  readonly id: string;
  readonly displayName: string;
  readonly family: string;
  readonly role: ModelRole;
  /** Approximate disk-download size (bytes). */
  readonly sizeBytes: number;
  /** Approximate resident RAM at runtime (bytes). */
  readonly ramRequiredBytes: number;
  readonly minTier: HardwareTierKey;
  readonly capabilities: ReadonlyArray<ModelCapability>;
  readonly tradeoff: string;
  readonly useCaseAxis?: ModelUseCaseAxis;
}

export interface ModelInstallPlanEntry {
  readonly id: string;
  readonly displayName: string;
  readonly role: ModelRole;
  readonly sizeBytes: number;
  readonly ramRequiredBytes: number;
}

export interface ModelInstallPlan {
  readonly primary: ModelCatalogueEntry;
  readonly companions: ReadonlyArray<ModelInstallPlanEntry>;
  readonly totalDownloadBytes: number;
  readonly totalRamBytes: number;
  readonly fitsHardware: boolean;
  readonly tier: HardwareTierKey;
  readonly reason: string;
  readonly alternatives: ReadonlyArray<ModelCatalogueEntry>;
}

/**
 * Vision lifecycle policy. The Moondream2 vision companion is loaded on
 * demand and unloaded after `idleTimeoutMs` to free RAM for the primary
 * model. The mode is a presentation hint for the Settings UI; the actual
 * idle timeout is the source of truth.
 */
export type VisionLifecycleMode = "aggressive" | "balanced" | "warm";

export interface VisionModelLifecycleConfig {
  readonly visionModelId: string;
  readonly mode: VisionLifecycleMode;
  readonly idleTimeoutMs: number;
}

/** Minimum-spec verdict surfaced to the UI when no plan fits. */
export interface MinimumSpecVerdict {
  readonly meetsMinimum: boolean;
  readonly minimumRamBytes: number;
  readonly detectedRamBytes: number;
  readonly message: string;
}
