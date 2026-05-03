/**
 * Inter-skill composition + cycle detection (Task #39).
 *
 * Skills declare `requiredSkills` in their manifest and call other
 * skills via `context.callSkill(id, input)` at runtime. Two safety
 * properties this module enforces:
 *
 *   1. **Static cycle detection** — at publish time the validator walks
 *      the declared dependency graph and rejects any cycle (DAG
 *      requirement). Implementation: depth-first search with a recursion
 *      stack.
 *   2. **Runtime call-stack guard** — at execution time we track the
 *      currently-running skill ids in an `AsyncLocalStorage` stack and
 *      refuse re-entry of any id already in the stack. This catches
 *      cycles that arise from dynamic dispatch (a skill calling a skill
 *      whose id was computed at runtime).
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { SkillExecutionManifest } from "@workspace/types";

import { ManifestValidationError } from "./manifest";

export class SkillCycleError extends Error {
  override readonly name = "SkillCycleError";
  readonly code = "SKILL_CYCLE";
  constructor(readonly cycle: ReadonlyArray<string>) {
    super(`Skill dependency cycle detected: ${cycle.join(" → ")}`);
  }
}

export type ManifestLookup = (
  id: string,
) => Promise<SkillExecutionManifest | null>;

/**
 * Walk the dependency graph starting from `manifest`. Each discovered
 * id is fetched via `lookup`; missing skills are skipped (the install
 * step would have caught them). Throws `SkillCycleError` on the first
 * cycle encountered.
 */
export async function assertNoDependencyCycle(
  manifest: SkillExecutionManifest,
  lookup: ManifestLookup,
): Promise<void> {
  const stack: string[] = [];
  const visited = new Set<string>();
  await visit(manifest, lookup, stack, visited);
}

async function visit(
  manifest: SkillExecutionManifest,
  lookup: ManifestLookup,
  stack: string[],
  visited: Set<string>,
): Promise<void> {
  if (stack.includes(manifest.id)) {
    const cycleStart = stack.indexOf(manifest.id);
    throw new SkillCycleError([...stack.slice(cycleStart), manifest.id]);
  }
  if (visited.has(manifest.id)) return;
  stack.push(manifest.id);
  for (const depId of manifest.requiredSkills ?? []) {
    const dep = await lookup(depId);
    if (!dep) continue;
    await visit(dep, lookup, stack, visited);
  }
  stack.pop();
  visited.add(manifest.id);
}

/**
 * Convenience helper: parsed publish-time check that surfaces as a
 * `ManifestValidationError` so the publish route can return a single
 * 400 with the offending path. The cycle string itself becomes the
 * error path so the UI can render "publish.requiredSkills:a→b→a".
 */
export async function checkPublishCycles(
  manifest: SkillExecutionManifest,
  lookup: ManifestLookup,
): Promise<void> {
  try {
    await assertNoDependencyCycle(manifest, lookup);
  } catch (e) {
    if (e instanceof SkillCycleError) {
      throw new ManifestValidationError(
        `dependency cycle: ${e.cycle.join(" → ")}`,
        "requiredSkills",
      );
    }
    throw e;
  }
}

// ─────────────── Runtime call-stack guard ─────────────────────────────

const callStackStorage = new AsyncLocalStorage<ReadonlyArray<string>>();

export class SkillReentryError extends Error {
  override readonly name = "SkillReentryError";
  readonly code = "SKILL_REENTRY";
  readonly callStack: ReadonlyArray<string>;
  constructor(readonly skillId: string, callStack: ReadonlyArray<string>) {
    super(
      `Refusing to re-enter skill "${skillId}" — current call stack: ${callStack.join(
        " → ",
      )}`,
    );
    this.callStack = callStack;
  }
}

/**
 * Push `skillId` onto the call stack while `fn` runs. Throws
 * `SkillReentryError` if `skillId` is already on the stack.
 */
export async function withSkillCallFrame<T>(
  skillId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = callStackStorage.getStore() ?? [];
  if (current.includes(skillId)) {
    throw new SkillReentryError(skillId, current);
  }
  return callStackStorage.run([...current, skillId], fn);
}

export function currentSkillCallStack(): ReadonlyArray<string> {
  return callStackStorage.getStore() ?? [];
}
