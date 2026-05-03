/**
 * Skill execution service (Task #39).
 *
 * Bridges the executor in `../skill-runtime/executor.ts` to the
 * tenant-scoped skill registry in `./skill.service`. Responsibilities:
 *
 *   - Load the persisted manifest + source for a skill id.
 *   - Build a default tool-binding map (the verbs declared in
 *     `manifest.requiredTools`). Bindings are stub-safe: if the host
 *     has not implemented a verb yet the binding throws a clear error
 *     so the skill author sees "tool not implemented" instead of
 *     undefined-behaviour.
 *   - Provide the `callSkill` recursion entry-point used for
 *     inter-skill composition.
 *   - Run a skill's manifest test cases (`runSkillTests`) for the CLI
 *     `op skill test` command and the creator dashboard.
 */
import type {
  SkillExecutionManifest,
  SkillResult,
  SkillTestCase,
} from "@workspace/types";
import { and, eq } from "drizzle-orm";
import { db, skills } from "@workspace/db";

import { logger } from "../lib/logger";
import { tenantScope } from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import {
  checkPublishCycles,
  type ManifestLookup,
} from "../skill-runtime/composition";
import {
  executeSkill,
  type SkillExecutionRequest,
} from "../skill-runtime/executor";
import {
  ManifestValidationError,
  parseManifest,
  TOOL_VERB_PERMISSIONS,
} from "../skill-runtime/manifest";
import type { SkillHostBinding } from "../skill-runtime/sandbox";

export class SkillExecutionNotFoundError extends Error {
  override readonly name = "SkillExecutionNotFoundError";
  readonly code = "SKILL_NOT_EXECUTABLE";
  constructor(id: string) {
    super(`Skill "${id}" has no execution manifest installed`);
  }
}

interface LoadedSkill {
  readonly manifest: SkillExecutionManifest;
  readonly source: string;
}

/**
 * Internal `id` resolution: callers may pass either a database row id
 * (`skill_<nanoid>`) or the slug-style `manifest.id` declared in the
 * execution manifest. We try both so requiredSkills + DB primary keys
 * resolve consistently — the manifest contract is the user-facing
 * identity surface and must work everywhere requiredSkills appears.
 */
async function loadSkill(
  ctx: TenantContext,
  idOrSlug: string,
): Promise<LoadedSkill | null> {
  const rows = await db
    .select()
    .from(skills)
    .where(
      and(
        tenantScope(ctx, skills),
        // SQLite OR via two predicates: id-equals OR slug-equals.
        // Drizzle composes them with `or(...)` from the helpers.
        // `or` is imported lazily to keep the existing import set tight.
        (await import("drizzle-orm")).or(
          eq(skills.id, idOrSlug),
          eq(skills.slug, idOrSlug),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.executionManifest) return null;
  let manifest: SkillExecutionManifest;
  try {
    manifest = parseManifest(JSON.parse(row.executionManifest));
  } catch (e) {
    logger.warn(
      { err: e, skillId: row.id },
      "Stored execution manifest failed to parse",
    );
    return null;
  }
  return { manifest, source: row.content };
}

/**
 * Lookup adapter for publish-time cycle checks. Resolves by manifest.id
 * (slug) OR DB row id; both forms appear in `requiredSkills` in the
 * wild because the marketplace serialises slugs while internal
 * tooling uses row ids.
 */
export function manifestLookupFor(ctx: TenantContext): ManifestLookup {
  return async (idOrSlug: string) => {
    const loaded = await loadSkill(ctx, idOrSlug);
    return loaded?.manifest ?? null;
  };
}

/** Validate `raw` and run the publish-time cycle check in one shot. */
export async function validatePublishManifest(
  ctx: TenantContext,
  raw: unknown,
): Promise<SkillExecutionManifest> {
  const manifest = parseManifest(raw);
  await checkPublishCycles(manifest, manifestLookupFor(ctx));
  return manifest;
}

/**
 * Build a stub binding for every verb declared in `manifest.requiredTools`.
 * Real host implementations override these by passing `overrides` —
 * for example the route handler binds `fetch` to the egress-audited HTTP
 * client. Verbs without an override throw when called so the failure
 * surfaces deterministically inside the sandbox.
 */
export function buildDefaultToolBindings(
  manifest: SkillExecutionManifest,
  overrides: Readonly<Record<string, SkillHostBinding>> = {},
): Record<string, SkillHostBinding> {
  const out: Record<string, SkillHostBinding> = {};
  for (const verb of manifest.requiredTools) {
    if (overrides[verb]) {
      out[verb] = overrides[verb];
      continue;
    }
    const permission = TOOL_VERB_PERMISSIONS[verb];
    if (!permission) continue;
    out[verb] = {
      permission,
      invoke: () => {
        throw new Error(
          `Host has not implemented tool "${verb}" — register a binding before invoking the skill`,
        );
      },
    };
  }
  return out;
}

export interface RunSkillOptions {
  readonly input: unknown;
  readonly toolOverrides?: Readonly<Record<string, SkillHostBinding>>;
  readonly memoryToken?: string;
  readonly invocationId?: string;
  readonly timeoutMs?: number;
}

export async function runInstalledSkill(
  ctx: TenantContext,
  id: string,
  options: RunSkillOptions,
): Promise<SkillResult> {
  const loaded = await loadSkill(ctx, id);
  if (!loaded) throw new SkillExecutionNotFoundError(id);
  const toolBindings = buildDefaultToolBindings(
    loaded.manifest,
    options.toolOverrides ?? {},
  );
  const callSkill = async (calleeId: string, calleeInput: unknown) => {
    return runInstalledSkill(ctx, calleeId, {
      input: calleeInput,
      toolOverrides: options.toolOverrides ?? {},
      memoryToken: options.memoryToken,
    });
  };
  const req: SkillExecutionRequest = {
    manifest: loaded.manifest,
    source: loaded.source,
    input: options.input,
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId ?? "",
    toolBindings,
    callSkill,
    memoryToken: options.memoryToken,
    timeoutMs: options.timeoutMs,
    invocationId: options.invocationId,
  };
  return executeSkill(req);
}

// ─────────────── Test runner ─────────────────────────────────────────

export interface SkillTestRunOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly status: SkillResult["status"];
  readonly elapsedMs: number;
  readonly failureReason?: string;
}

export interface SkillTestRunReport {
  readonly skillId: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly outcomes: ReadonlyArray<SkillTestRunOutcome>;
}

export async function runSkillTests(
  ctx: TenantContext,
  id: string,
): Promise<SkillTestRunReport> {
  const loaded = await loadSkill(ctx, id);
  if (!loaded) throw new SkillExecutionNotFoundError(id);
  const cases = loaded.manifest.testCases ?? [];
  const outcomes: SkillTestRunOutcome[] = [];
  for (const tc of cases) {
    if (!tc) continue;
    outcomes.push(await runOneTest(ctx, id, tc));
  }
  const passed = outcomes.filter((o) => o.passed).length;
  return {
    skillId: id,
    total: outcomes.length,
    passed,
    failed: outcomes.length - passed,
    outcomes,
  };
}

async function runOneTest(
  ctx: TenantContext,
  id: string,
  tc: SkillTestCase,
): Promise<SkillTestRunOutcome> {
  try {
    const result = await runInstalledSkill(ctx, id, {
      input: tc.input,
      timeoutMs: tc.timeoutMs,
    });
    const expectedStatus = tc.expectedStatus ?? "success";
    if (result.status !== expectedStatus) {
      return {
        name: tc.name,
        passed: false,
        status: result.status,
        elapsedMs: result.elapsedMs,
        failureReason: `expected status "${expectedStatus}" got "${result.status}"${result.error ? ` — ${result.error.message}` : ""}`,
      };
    }
    if (
      tc.expectedSummaryIncludes !== undefined &&
      !result.summary.includes(tc.expectedSummaryIncludes)
    ) {
      return {
        name: tc.name,
        passed: false,
        status: result.status,
        elapsedMs: result.elapsedMs,
        failureReason: `summary did not include "${tc.expectedSummaryIncludes}"`,
      };
    }
    if (
      tc.expectedOutput !== undefined &&
      !deepEqual(result.output, tc.expectedOutput)
    ) {
      return {
        name: tc.name,
        passed: false,
        status: result.status,
        elapsedMs: result.elapsedMs,
        failureReason: `output did not match expectation`,
      };
    }
    return {
      name: tc.name,
      passed: true,
      status: result.status,
      elapsedMs: result.elapsedMs,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      name: tc.name,
      passed: false,
      status: "failure",
      elapsedMs: 0,
      failureReason: message,
    };
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

// Re-export the publish validator's error class so route handlers can
// pattern-match without importing from two modules.
export { ManifestValidationError };

/**
 * Persist an execution manifest onto a skill row. Validates and
 * cycle-checks the manifest first; throws `ManifestValidationError` on
 * any violation so the route returns a single 400.
 */
export async function attachExecutionManifest(
  ctx: TenantContext,
  id: string,
  raw: unknown,
): Promise<SkillExecutionManifest> {
  const manifest = await validatePublishManifest(ctx, raw);
  const updated = await db
    .update(skills)
    .set({
      executionManifest: JSON.stringify(manifest),
      updatedAt: Date.now(),
    })
    .where(and(tenantScope(ctx, skills), eq(skills.id, id)))
    .returning();
  if (updated.length === 0) {
    throw new SkillExecutionNotFoundError(id);
  }
  return manifest;
}
