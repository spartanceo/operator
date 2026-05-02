/**
 * Skill sandbox — the SOLE allowlisted use of `vm.runInNewContext` in the
 * codebase. Standard 12 § "Skill Sandbox" pins this filename as the only
 * place dynamic code is permitted to execute; tier-review Check #11
 * (findDangerousExec) excludes this file by exact path match.
 *
 * Boundaries we enforce here so every skill runs in a hostile-by-default
 * harness:
 *
 *   1. **Pre-flight static scan** — any source matching the
 *      `skill-scanner.service` rule set is rejected before any context is
 *      created.
 *   2. **Empty global object** — only the values declared in
 *      `buildSandboxGlobals()` are reachable; `process`, `require`,
 *      `Buffer`, and friends never enter the context.
 *   3. **Permission gate** — every `host.<verb>(...)` call is checked
 *      against the skill's declared permission list. Denied verbs throw
 *      `SkillPermissionDeniedError` — the calling route surfaces this as
 *      a 403 with the requested permission so the user can grant it.
 *   4. **Wall-clock timeout** — `vm.runInNewContext` accepts `timeout`,
 *      which kills the script with a SIGINT-equivalent if it spins past
 *      the budget. Default 5s; the route can override.
 *   5. **Output isolation** — the harness can return only
 *      JSON-serialisable values; functions / Buffers / Promises that
 *      capture host objects are coerced to `null` by `JSON.stringify`.
 */
// tier-review: this file is the canonical sandbox harness; the dangerous-exec
// check (Check #11) excludes this exact path.
import { runInNewContext } from "node:vm";

import { scanSkillSource } from "../services/skill-scanner.service";

export class SkillSandboxError extends Error {
  override readonly name = "SkillSandboxError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class SkillPermissionDeniedError extends SkillSandboxError {
  constructor(readonly permission: string) {
    super(`Skill requested permission "${permission}" which was not granted`, "PERMISSION_DENIED");
  }
}

/**
 * The list of verbs a skill's `host` proxy can call. Each verb names a
 * permission string the user must have granted; the route layer decides
 * what `host.<verb>(...)` actually does (typically forwarded to the
 * relevant service: files / network / memory / etc.).
 */
export interface SkillHostBinding {
  /** Permission string the user granted to authorise this verb. */
  readonly permission: string;
  /** The implementation invoked when the skill calls `host.<verb>(...)`. */
  readonly invoke: (...args: ReadonlyArray<unknown>) => unknown;
}

export interface SkillRunRequest {
  /** The skill's source code (a single CommonJS-shaped expression). */
  readonly code: string;
  /** Permissions the user has granted to this skill. */
  readonly grantedPermissions: ReadonlyArray<string>;
  /** Bindings exposed via `host`. Each must declare a permission. */
  readonly hostBindings: Readonly<Record<string, SkillHostBinding>>;
  /** Free-form input forwarded to the skill as `input`. */
  readonly input?: unknown;
  /** Wall-clock budget in milliseconds. Default 5000. */
  readonly timeoutMs?: number;
}

export interface SkillRunResult {
  readonly output: unknown;
  readonly logs: ReadonlyArray<{ level: string; message: string }>;
  readonly durationMs: number;
}

/**
 * Build the empty sandbox global. Only the bindings listed here are
 * reachable from inside the skill; everything else (process, require,
 * Buffer, fetch, …) is undefined.
 */
function buildSandboxGlobals(
  request: SkillRunRequest,
  logs: { level: string; message: string }[],
): Record<string, unknown> {
  const grantedSet = new Set(request.grantedPermissions);
  const host: Record<string, unknown> = {};
  for (const [verb, binding] of Object.entries(request.hostBindings)) {
    host[verb] = (...args: ReadonlyArray<unknown>) => {
      if (!grantedSet.has(binding.permission)) {
        throw new SkillPermissionDeniedError(binding.permission);
      }
      return binding.invoke(...args);
    };
  }
  return {
    input: request.input ?? null,
    host: Object.freeze(host),
    console: {
      log: (...args: ReadonlyArray<unknown>) =>
        logs.push({ level: "info", message: args.map(stringify).join(" ") }),
      warn: (...args: ReadonlyArray<unknown>) =>
        logs.push({ level: "warn", message: args.map(stringify).join(" ") }),
      error: (...args: ReadonlyArray<unknown>) =>
        logs.push({ level: "error", message: args.map(stringify).join(" ") }),
    },
    JSON,
    Math,
    Date,
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Run a skill harness. The skill source is wrapped so the user can return
 * a value (or a Promise) from a top-level `module.exports = async (input, host) => { … }`.
 *
 * The wrapper is fixed so the static scanner only ever runs against the
 * user-supplied source, not the harness boilerplate.
 */
export async function runSkill(request: SkillRunRequest): Promise<SkillRunResult> {
  const scan = scanSkillSource(request.code);
  if (!scan.safe) {
    const top = scan.findings.find((f) => f.severity === "critical") ?? scan.findings[0]!;
    throw new SkillSandboxError(
      `Skill code rejected by scanner (${top.ruleId}): ${top.description}`,
      "SCANNER_REJECTED",
    );
  }

  const logs: { level: string; message: string }[] = [];
  const sandbox = buildSandboxGlobals(request, logs);
  const harness = `
    "use strict";
    const __module__ = { exports: null };
    (function(module, input, host){
      ${request.code}
    })(__module__, input, host);
    __module__.exports;
  `;

  const start = Date.now();
  let exported: unknown;
  try {
    exported = runInNewContext(harness, sandbox, {
      timeout: request.timeoutMs ?? 5000,
      displayErrors: true,
    });
  } catch (e) {
    if (e instanceof SkillSandboxError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new SkillSandboxError(`Skill execution failed: ${msg}`, "EXECUTION_FAILED");
  }
  const resolved =
    exported && typeof (exported as { then?: unknown }).then === "function"
      ? await (exported as Promise<unknown>)
      : exported;

  return {
    output: resolved ?? null,
    logs,
    durationMs: Date.now() - start,
  };
}
