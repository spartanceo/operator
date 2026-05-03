/**
 * Runtime registry — the single place that knows which adapters exist and
 * resolves "active runtime" for a given tenant.
 *
 * Keeps the adapter set static (no dynamic registration in v1) so the
 * tier-review unbounded-cache gate (Check #18) is satisfied without a
 * justification comment.
 *
 * Cloud adapters are gated behind per-session confirmation: see
 * `assertCloudConfirmed()` — the routes layer is responsible for invoking
 * this before dispatching a chat call when the active adapter's residency
 * is anything other than "local".
 */
import type { TenantContext } from "@workspace/types";

import { ollamaAdapter } from "./adapters/ollama.adapter";
import { lmstudioAdapter, janAdapter, llamafileAdapter } from "./adapters/openai-compat.adapter";
import { openaiAdapter } from "./adapters/openai.adapter";
import { anthropicAdapter } from "./adapters/anthropic.adapter";
import type { ModelRuntime, RuntimeResidency } from "./types";

export const ALL_RUNTIMES: ReadonlyArray<ModelRuntime> = [
  ollamaAdapter,
  lmstudioAdapter,
  janAdapter,
  llamafileAdapter,
  openaiAdapter,
  anthropicAdapter,
];

// tier-review: bounded — built once from the static ALL_RUNTIMES tuple, never mutated
const BY_ID: ReadonlyMap<string, ModelRuntime> = new Map(
  ALL_RUNTIMES.map((r) => [r.id, r] as const),
);

export function listRuntimes(): ReadonlyArray<ModelRuntime> {
  return ALL_RUNTIMES;
}

export function getRuntime(id: string): ModelRuntime | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Resolve the residency signal for a runtime id, or "local" by default
 * for unknown ids — the Privacy Meter must always render *something*.
 */
export function residencyFor(id: string): RuntimeResidency {
  return BY_ID.get(id)?.residency ?? "local";
}

/**
 * Walk every adapter's detect() in parallel and return the ids of the
 * local runtimes that responded. Used by the auto-detection endpoint and
 * by the registry's "fall back to first detected local runtime" path
 * when the user hasn't pinned a choice yet.
 *
 * Cloud adapters always pass detect() so we filter to local only here —
 * cloud availability is decided by health() with credentials, not detect().
 */
export async function detectLocalRuntimes(ctx: TenantContext): Promise<string[]> {
  const locals = ALL_RUNTIMES.filter((r) => r.residency === "local");
  const results = await Promise.all(locals.map((r) => r.detect(ctx).then((ok) => [r.id, ok] as const)));
  return results.filter(([, ok]) => ok).map(([id]) => id);
}
