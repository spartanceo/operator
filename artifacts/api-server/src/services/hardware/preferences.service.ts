/**
 * Persistent model preferences — primary model + vision lifecycle (Task #64).
 *
 * Singleton-per-tenant via the `model_preferences` table. The id IS the
 * tenantId so the upsert is a deterministic INSERT-or-UPDATE keyed on the
 * primary key, with no ON CONFLICT clause needed (read-then-dispatch like
 * the onboarding-profiles service).
 *
 * The columns are mutable — unlike the onboarding-profile flags there are
 * no monotonic invariants. Settings can flip the user's primary model and
 * the vision-lifecycle mode at will.
 */
import { and, eq } from "drizzle-orm";

import { db, modelPreferences, tenantScope, withTenantValues } from "@workspace/db";
import type {
  TenantContext,
  VisionLifecycleMode,
  VisionModelLifecycleConfig,
} from "@workspace/types";

import { defaultLifecycleForTier, timeoutForMode } from "./vision-lifecycle";
import { getHardwareProfile } from "./cache";
import { getSelectableModelEntry } from "./catalogue";
import { buildModelInstallPlan } from "./recommendation";

export interface ModelPreferencesView {
  readonly tenantId: string;
  readonly primaryModel: string | null;
  readonly visionLifecycle: VisionModelLifecycleConfig;
  readonly catalogueChoiceMade: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertModelPreferencesInput {
  primaryModel?: string;
  visionLifecycleMode?: VisionLifecycleMode;
  visionIdleTimeoutMs?: number;
  catalogueChoiceMade?: boolean;
}

/**
 * Sentinel raised when an upsert references an unknown primary model id.
 * Routes catch this specifically to map to a 400, while letting all other
 * (DB / runtime) errors bubble up to the global handler — preserving
 * observability instead of silently flattening every failure into 400.
 */
export class UnknownModelError extends Error {
  readonly code = "INVALID_MODEL" as const;
  constructor(modelId: string) {
    super(`Unknown primary model "${modelId}"`);
    this.name = "UnknownModelError";
  }
}

// tier-review: bounded — fixed 3-element enum allow-list, not a dynamic cache.
const VALID_VISION_MODES: ReadonlySet<VisionLifecycleMode> = new Set([
  "aggressive",
  "balanced",
  "warm",
]);

function coerceVisionMode(
  raw: string | null,
  fallback: VisionLifecycleMode,
): VisionLifecycleMode {
  if (raw && (VALID_VISION_MODES as ReadonlySet<string>).has(raw)) {
    return raw as VisionLifecycleMode;
  }
  return fallback;
}

function defaultLifecycleForCurrentHost(): VisionModelLifecycleConfig {
  return defaultLifecycleForTier(getHardwareProfile().tier);
}

function rowToView(
  r: typeof modelPreferences.$inferSelect,
): ModelPreferencesView {
  const fallback = defaultLifecycleForCurrentHost();
  // Guard the DB string against drift — a row with a foreign value (e.g.
  // from a future migration that introduces a new mode and rolled back)
  // should not silently become `undefined` at runtime. Fall back to the
  // tier-default mode instead.
  const mode = coerceVisionMode(r.visionLifecycleMode, fallback.mode);
  const timeout =
    r.visionIdleTimeoutMs !== null && r.visionIdleTimeoutMs !== undefined
      ? r.visionIdleTimeoutMs
      : timeoutForMode(mode);
  return {
    tenantId: r.tenantId,
    primaryModel: r.primaryModel,
    visionLifecycle: {
      visionModelId: fallback.visionModelId,
      mode,
      idleTimeoutMs: timeout,
    },
    catalogueChoiceMade: r.catalogueChoiceMade === 1,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function getModelPreferences(
  ctx: TenantContext,
): Promise<ModelPreferencesView | null> {
  const rows = await db
    .select()
    .from(modelPreferences)
    .where(
      and(
        tenantScope(ctx, modelPreferences),
        eq(modelPreferences.id, ctx.tenantId),
      ),
    )
    .limit(1);
  return rows[0] ? rowToView(rows[0]) : null;
}

/**
 * Read-or-default: returns the persisted row if any, otherwise a synthetic
 * view backed by the recommendation engine + tier-default vision policy.
 * The returned object is always safe to render in Settings without a
 * conditional render path for "no row yet".
 */
export async function getEffectiveModelPreferences(
  ctx: TenantContext,
): Promise<ModelPreferencesView> {
  const persisted = await getModelPreferences(ctx);
  if (persisted) return persisted;
  const hardware = getHardwareProfile();
  const plan = buildModelInstallPlan(hardware);
  const lifecycle = defaultLifecycleForCurrentHost();
  const now = new Date().toISOString();
  return {
    tenantId: ctx.tenantId,
    primaryModel: plan?.primary.id ?? null,
    visionLifecycle: lifecycle,
    catalogueChoiceMade: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function upsertModelPreferences(
  ctx: TenantContext,
  input: UpsertModelPreferencesInput,
): Promise<ModelPreferencesView> {
  if (input.primaryModel !== undefined) {
    // Accept any primary from the curated catalogue OR the broader
    // Ollama library exposed in power-user mode. Reject anything else
    // (the API contract is "pick from a known model id" — arbitrary
    // user-supplied ids still go through the Pull-by-name flow).
    const entry = await getSelectableModelEntry(input.primaryModel);
    if (!entry || entry.role !== "primary") {
      throw new UnknownModelError(input.primaryModel);
    }
  }

  const row = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(modelPreferences)
      .where(
        and(
          tenantScope(ctx, modelPreferences),
          eq(modelPreferences.id, ctx.tenantId),
        ),
      )
      .limit(1)
      .all();
    const now = Date.now();
    const lifecycleFromMode =
      input.visionLifecycleMode !== undefined
        ? {
            mode: input.visionLifecycleMode,
            timeout:
              input.visionIdleTimeoutMs ??
              timeoutForMode(input.visionLifecycleMode),
          }
        : null;

    if (existing.length === 0) {
      const fallback = defaultLifecycleForCurrentHost();
      tx.insert(modelPreferences)
        .values(
          withTenantValues(ctx, {
            id: ctx.tenantId,
            primaryModel: input.primaryModel ?? null,
            visionLifecycleMode:
              lifecycleFromMode?.mode ?? fallback.mode,
            visionIdleTimeoutMs:
              lifecycleFromMode?.timeout ?? fallback.idleTimeoutMs,
            catalogueChoiceMade:
              input.catalogueChoiceMade === true ? 1 : 0,
            createdAt: now,
            updatedAt: now,
            version: 1,
          }),
        )
        .run();
    } else {
      const prev = existing[0];
      if (!prev) throw new Error("model preferences race: row vanished");
      tx.update(modelPreferences)
        .set({
          primaryModel: input.primaryModel ?? prev.primaryModel,
          visionLifecycleMode:
            lifecycleFromMode?.mode ?? prev.visionLifecycleMode,
          visionIdleTimeoutMs:
            input.visionIdleTimeoutMs ??
            (lifecycleFromMode?.timeout ?? prev.visionIdleTimeoutMs),
          catalogueChoiceMade:
            input.catalogueChoiceMade === true
              ? 1
              : prev.catalogueChoiceMade,
          updatedAt: now,
          version: prev.version + 1,
        })
        .where(
          and(
            tenantScope(ctx, modelPreferences),
            eq(modelPreferences.id, ctx.tenantId),
          ),
        )
        .run();
    }

    const after = tx
      .select()
      .from(modelPreferences)
      .where(
        and(
          tenantScope(ctx, modelPreferences),
          eq(modelPreferences.id, ctx.tenantId),
        ),
      )
      .limit(1)
      .all();
    if (!after[0]) {
      throw new Error("model preferences not found after upsert");
    }
    return rowToView(after[0]);
  });

  return Promise.resolve(row);
}
