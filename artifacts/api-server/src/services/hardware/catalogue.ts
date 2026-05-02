/**
 * Model catalogue — data-driven source of truth for hardware-aware model
 * recommendation (Task #64).
 *
 * Adding a primary or vision model is a one-entry edit here; the
 * recommendation engine, the API responses, and the onboarding chooser
 * all read this list at runtime. No code branching encodes "which model
 * for which tier" — that lives entirely in the data (Standard 12).
 *
 * Why TypeScript and not JSON: the data is consumed only by other modules
 * in this server bundle, and a `.ts` file gives us inline `as const`
 * narrowing plus an explicit `ModelCatalogueEntry` type without wiring
 * `resolveJsonModule` into every downstream tsconfig. Treat this file as
 * a JSON-shaped data module — only the array literal should ever change.
 *
 * Sizing notes:
 *  - `sizeBytes`         — approximate Q4 download size from the Ollama
 *                          registry (used to set user expectations on the
 *                          install screen).
 *  - `ramRequiredBytes`  — typical resident RAM at inference time. Used by
 *                          the recommendation engine to verify a primary
 *                          model + the loaded vision companion fits the
 *                          host's RAM with reasonable headroom.
 */
import type {
  ModelCatalogueEntry,
  HardwareTierKey,
} from "@workspace/types";

const ONE_GB = 1024 * 1024 * 1024;

export const MODEL_CATALOGUE: ReadonlyArray<ModelCatalogueEntry> = [
  // Primary models — ordered low → pro, then alternatives. The
  // recommendation engine sorts at query time; declaration order does
  // not affect output.
  {
    id: "phi3:mini",
    displayName: "Phi-3 Mini (3.8B)",
    family: "phi",
    role: "primary",
    sizeBytes: 2 * ONE_GB,
    ramRequiredBytes: 3 * ONE_GB,
    minTier: "low",
    capabilities: ["writing", "agent", "general"],
    tradeoff:
      "Smallest footprint — runs on lean hardware. Less nuanced on long reasoning.",
    useCaseAxis: "balanced",
  },
  {
    id: "mistral:7b",
    displayName: "Mistral 7B",
    family: "mistral",
    role: "primary",
    sizeBytes: 4 * ONE_GB,
    ramRequiredBytes: 5 * ONE_GB,
    minTier: "mid",
    capabilities: ["writing", "code", "general"],
    tradeoff:
      "Strong all-rounder for 8GB+ machines. A bit slower than Llama 3.1 8B on the agent loop.",
    useCaseAxis: "writing",
  },
  {
    id: "qwen2.5-coder:7b",
    displayName: "Qwen 2.5 Coder 7B",
    family: "qwen",
    role: "primary",
    sizeBytes: 4 * ONE_GB,
    ramRequiredBytes: 5 * ONE_GB,
    minTier: "mid",
    capabilities: ["code", "reasoning", "general"],
    tradeoff:
      "Best in class for code review, refactor, and tool-use at this RAM tier.",
    useCaseAxis: "code",
  },
  {
    id: "llama3.1:8b",
    displayName: "Llama 3.1 8B",
    family: "llama",
    role: "primary",
    sizeBytes: 5 * ONE_GB,
    ramRequiredBytes: 6 * ONE_GB,
    minTier: "high",
    capabilities: ["writing", "code", "agent", "general", "reasoning"],
    tradeoff:
      "Best balance of speed, agent reliability, and quality on 16GB hosts.",
    useCaseAxis: "balanced",
  },
  {
    id: "llama3.1:70b",
    displayName: "Llama 3.1 70B",
    family: "llama",
    role: "primary",
    sizeBytes: 40 * ONE_GB,
    ramRequiredBytes: 42 * ONE_GB,
    minTier: "pro",
    capabilities: ["writing", "code", "agent", "general", "reasoning"],
    tradeoff:
      "Highest local quality. Requires a workstation-class GPU or 64GB+ unified memory.",
    useCaseAxis: "balanced",
  },
  // Vision companion — auto-bundled with every primary as long as the
  // headroom calculation says it fits.
  {
    id: "moondream:v2",
    displayName: "Moondream 2 (Vision)",
    family: "moondream",
    role: "vision",
    sizeBytes: Math.round(1.7 * ONE_GB),
    ramRequiredBytes: Math.round(1.6 * ONE_GB),
    minTier: "low",
    capabilities: ["vision"],
    tradeoff:
      "Lightweight vision model loaded on demand, then unloaded after idle to free RAM.",
  },
];

/** Reserve baseline RAM for the OS, the app shell, and tool execution. */
export const SYSTEM_RAM_RESERVATION_BYTES = 2 * ONE_GB;

/**
 * Smallest primary model in the catalogue. The minimum-spec verdict uses
 * this to compute the absolute lower bound a host must satisfy.
 */
export function getMinimumPrimary(): ModelCatalogueEntry {
  // tier-review: bounded — single-pass min over a small static array.
  const primaries = MODEL_CATALOGUE.filter((m) => m.role === "primary");
  let smallest: ModelCatalogueEntry | null = null;
  for (const m of primaries) {
    if (!smallest || m.ramRequiredBytes < smallest.ramRequiredBytes) {
      smallest = m;
    }
  }
  if (!smallest) {
    throw new Error("Model catalogue has no primary models");
  }
  return smallest;
}

/** First vision model in the catalogue (currently Moondream 2). */
export function getDefaultVision(): ModelCatalogueEntry | null {
  return MODEL_CATALOGUE.find((m) => m.role === "vision") ?? null;
}

/** Stable lookup by id. */
export function getCatalogueEntry(
  id: string,
): ModelCatalogueEntry | undefined {
  return MODEL_CATALOGUE.find((m) => m.id === id);
}

/** Thresholds shared between the detector and the recommendation engine. */
export const TIER_THRESHOLDS_BYTES: Record<HardwareTierKey, number> = {
  low: 0,
  mid: 8 * ONE_GB,
  high: 16 * ONE_GB,
  pro: 32 * ONE_GB,
};

export function tierForRam(totalRamBytes: number): HardwareTierKey {
  if (totalRamBytes >= TIER_THRESHOLDS_BYTES.pro) return "pro";
  if (totalRamBytes >= TIER_THRESHOLDS_BYTES.high) return "high";
  if (totalRamBytes >= TIER_THRESHOLDS_BYTES.mid) return "mid";
  return "low";
}
