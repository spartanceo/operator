/**
 * `services/hardware/` barrel — Task #64.
 *
 * Single import surface for the hardware-aware model recommendation
 * subsystem: detection, catalogue, recommendation engine, vision lifecycle,
 * and persistent model preferences.
 */
export {
  MODEL_CATALOGUE,
  SYSTEM_RAM_RESERVATION_BYTES,
  TIER_THRESHOLDS_BYTES,
  getCatalogueEntry,
  getDefaultVision,
  getMinimumPrimary,
  getSelectableModelEntry,
  tierForRam,
} from "./catalogue";
export { OLLAMA_LIBRARY } from "./library";
export {
  __clearAnalyticsMarkerForTests,
  isAnalyticsOptedIn,
  recordHardwareDetectionIfOptedIn,
  resetHardwareAnalyticsSinkForTests,
  setHardwareAnalyticsSinkForTests,
  type HardwareAnalyticsEvent,
  type HardwareAnalyticsSink,
} from "./analytics";
export { detectHardware, probeGpu, type GpuInfo } from "./detector";
export {
  __clearHardwareCacheMemoForTests,
  clearHardwareCache,
  getHardwareProfile,
} from "./cache";
export {
  buildModelInstallPlan,
  evaluateMinimumSpec,
  recommendModelLegacy,
} from "./recommendation";
export {
  defaultLifecycleForTier,
  getVisionLifecycle,
  resetVisionLifecycleForTests,
  timeoutForMode,
} from "./vision-lifecycle";
export {
  getEffectiveModelPreferences,
  getModelPreferences,
  UnknownModelError,
  upsertModelPreferences,
} from "./preferences.service";
export type {
  ModelPreferencesView,
  UpsertModelPreferencesInput,
} from "./preferences.service";
