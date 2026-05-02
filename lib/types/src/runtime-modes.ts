/**
 * Hardware-aware runtime modes for the Resource Governor (Task #36) and the
 * model lifecycle manager (Task #30). Declared centrally here so every layer
 * (UI, scheduler, agent loop) refers to the same identifier.
 *
 * Sequential — one model resident at a time; cold-swap between requests.
 *   Targets 8 GB devices.
 * Parallel   — multiple specialised models warm at once; route per-task.
 *   Targets 16 GB+ devices.
 */
export type RuntimeMode = "sequential" | "parallel";

/**
 * Coarse hardware tier the app auto-detects at first run (Task #30) and lets
 * the user override in settings.
 */
export interface HardwareTier {
  readonly mode: RuntimeMode;
  readonly totalRamGb: number;
  /** Free VRAM at startup, when a discrete GPU is present. */
  readonly vramGb?: number;
  /** Whether discrete GPU acceleration is available (Apple Silicon, NVIDIA, …). */
  readonly hasGpu: boolean;
}
