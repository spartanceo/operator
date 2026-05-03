/**
 * Skill executor (Task #39).
 *
 * The executor is the single entry-point for invoking a skill from a
 * route, the agent loop, the CLI test runner, or another skill via
 * `context.callSkill(...)`. It is the only caller of `runSkill()` in
 * `./sandbox.ts` (the canonical sandbox harness; Standard 12).
 *
 * What this module does on every invocation:
 *
 *   1. Validate `input` against `manifest.inputSchema`.
 *   2. Build the `SkillContext` (input, tools allow-list, callSkill,
 *      memoryToken, progress reporter, deadline).
 *   3. Push the skill id onto the runtime call-stack (cycle guard).
 *   4. Wrap the user's source so it can be authored either as
 *      `module.exports = async (context) => result` (preferred) or as
 *      legacy `(input, host) => result` (back-compat).
 *   5. Enforce the manifest timeout via `runSkill()`.
 *   6. Validate the returned `output` against `manifest.outputSchema`,
 *      coerce a `SkillResult` envelope, publish the terminal "100%"
 *      progress event, and return.
 */
import { randomUUID } from "node:crypto";

import type {
  SkillContext,
  SkillExecutionManifest,
  SkillProgressEvent,
  SkillResult,
  SkillStatus,
} from "@workspace/types";

import {
  validateAgainstSchema,
  type JsonSchemaError,
} from "./manifest";
import {
  endProgress,
  publishProgress,
} from "./progress-bus";
import {
  withSkillCallFrame,
} from "./composition";
import {
  runSkill,
  SkillSandboxError,
  type SkillHostBinding,
} from "./sandbox";

export class SkillInputValidationError extends Error {
  override readonly name = "SkillInputValidationError";
  readonly code = "SKILL_INPUT_INVALID";
  constructor(readonly errors: ReadonlyArray<JsonSchemaError>) {
    super(`Skill input failed schema validation: ${summarise(errors)}`);
  }
}

export class SkillOutputValidationError extends Error {
  override readonly name = "SkillOutputValidationError";
  readonly code = "SKILL_OUTPUT_INVALID";
  constructor(readonly errors: ReadonlyArray<JsonSchemaError>) {
    super(`Skill output failed schema validation: ${summarise(errors)}`);
  }
}

function summarise(errors: ReadonlyArray<JsonSchemaError>): string {
  return errors
    .slice(0, 5)
    .map((e) => `${e.path}: ${e.message}`)
    .join("; ");
}

export interface SkillExecutionRequest {
  /** The validated execution manifest (parsed via `parseManifest`). */
  readonly manifest: SkillExecutionManifest;
  /** The skill source — JavaScript text the sandbox runs. */
  readonly source: string;
  /** User-supplied input; validated against `manifest.inputSchema`. */
  readonly input: unknown;
  /** Active tenant context — wired into the SkillContext. */
  readonly tenantId: string;
  readonly workspaceId: string;
  /**
   * Bindings for `manifest.requiredTools`. The executor enforces:
   *   - every required verb has a binding here, OR
   *   - the binding is missing AND the skill calls the verb → 403-style
   *     `SkillSandboxError` from the sandbox (permission denied).
   */
  readonly toolBindings: Readonly<Record<string, SkillHostBinding>>;
  /** Used by `context.callSkill(...)`; defaults to a "deny" stub. */
  readonly callSkill?: (id: string, input: unknown) => Promise<SkillResult>;
  /** Memory access token — opaque to the runtime. */
  readonly memoryToken?: string;
  /** Optional override; capped at `manifest.timeoutMs`. */
  readonly timeoutMs?: number;
  /**
   * Optional caller-supplied invocation id. Defaults to a UUID. The
   * progress endpoint subscribes by this id.
   */
  readonly invocationId?: string;
}

export async function executeSkill(
  request: SkillExecutionRequest,
): Promise<SkillResult> {
  const { manifest, source } = request;
  const invocationId = request.invocationId ?? randomUUID();
  const start = Date.now();

  // 1. Validate input.
  const inputErrors = validateAgainstSchema(request.input, manifest.inputSchema);
  if (inputErrors.length > 0) {
    return failureResult(
      request.tenantId,
      invocationId,
      manifest,
      "SKILL_INPUT_INVALID",
      `Input failed validation: ${summarise(inputErrors)}`,
      Date.now() - start,
    );
  }

  // 2. Resolve the timeout (manifest cap is authoritative).
  const timeoutMs = Math.min(
    manifest.timeoutMs,
    request.timeoutMs ?? manifest.timeoutMs,
  );
  const deadline = start + timeoutMs;

  // 3. Build the host bindings the sandbox sees. Permissions are
  //    enforced by `sandbox.ts` per call. We only inject `callSkill`
  //    when the manifest declares the `skills:invoke` permission so
  //    the contract guarantee — "skills cannot reach beyond declared
  //    permissions" — holds even at the binding layer.
  const mayInvokeSkills = manifest.permissions.includes("skills:invoke");
  const callSkill = request.callSkill ?? denyCallSkill;
  const hostBindings: Record<string, SkillHostBinding> = {
    ...request.toolBindings,
    report: {
      // `report` is not gated by a granted permission — every skill may
      // surface progress to the chat without explicit consent.
      permission: "__progress__",
      invoke: (...args: ReadonlyArray<unknown>) => {
        const [fraction, message] = args;
        const event: SkillProgressEvent = {
          invocationId,
          skillId: manifest.id,
          fraction: clampFraction(fraction),
          message: typeof message === "string" ? message.slice(0, 500) : "",
          at: new Date().toISOString(),
        };
        publishProgress(request.tenantId, event);
      },
    },
  };
  if (mayInvokeSkills) {
    hostBindings["callSkill"] = {
      permission: "skills:invoke",
      invoke: (...args: ReadonlyArray<unknown>) => {
        const [calleeId, calleeInput] = args;
        if (typeof calleeId !== "string") {
          throw new TypeError("callSkill(id, input) — id must be a string");
        }
        return callSkill(calleeId, calleeInput);
      },
    };
  }

  // The progress verb must be reachable irrespective of granted perms;
  // we splice it into the granted set just for this invocation. We do
  // NOT add `skills:invoke` unconditionally — it stays declared.
  const grantedPermissions = [...manifest.permissions, "__progress__"];

  // 4. Wrap the source so the skill can use the rich `(context)` shape
  //    or the legacy `(input, host)` shape interchangeably. The
  //    wrapper builds the SkillContext object inside the sandbox so it
  //    is fully sealed (no host references leak in).
  const wrappedSource = `
    const __ctx__ = {
      tenantId: ${JSON.stringify(request.tenantId)},
      workspaceId: ${JSON.stringify(request.workspaceId)},
      invocationId: ${JSON.stringify(invocationId)},
      skillId: ${JSON.stringify(manifest.id)},
      deadline: ${deadline},
      input: input,
      memoryToken: ${JSON.stringify(request.memoryToken ?? "")},
      report: (fraction, message) => host.report(fraction, message),
      // ctx.log is wired below to the sandbox console (which sandbox.ts
      // captures into the SkillResult.logs buffer). Stub it here so a
      // skill that calls ctx.log before the wiring runs is still safe.
      log: () => {},
      availableTools: ${JSON.stringify(manifest.requiredTools)},
      callSkill: (id, input) => host.callSkill(id, input),
    };
    // Rebuild the host proxy with each declared tool verb bound to
    // host.<verb> so the legacy and modern shapes share one source of
    // truth for permission gating.
    const __tools__ = {};
    for (const verb of __ctx__.availableTools) {
      __tools__[verb] = (...args) => host[verb](...args);
    }
    __ctx__.tools = __tools__;
    // The legacy ctx.log is preserved for back-compat. Inside the sandbox
    // there is no Pino logger; the sandbox harness in sandbox.ts captures
    // console output into the SkillResult.logs buffer via its own
    // console binding, so we route through the sandbox console here.
    __ctx__.log = (level, message) => {
      const c = (typeof console !== "undefined" ? console : null);
      if (!c) return;
      const fn = level === "warn" ? c.warn : level === "error" ? c.error : c.info;
      fn(String(message));
    };
    ${source}
    if (typeof module.exports === "function") {
      const fn = module.exports;
      // Detect arity: 1 → modern (context), 2 → legacy (input, host).
      module.exports = fn.length >= 2 ? fn(input, host) : fn(__ctx__);
    }
  `;

  // 5 + 6. Run inside the cycle-guarded call frame and the sandbox.
  //        Promise.race with a hard deadline timer guarantees the
  //        invocation cannot exceed `timeoutMs` even if the skill
  //        kept long-lived async handles after the sync code returned
  //        (vm timeout only bounds the synchronous evaluation phase).
  let raw: unknown;
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const sandboxRun = withSkillCallFrame(manifest.id, () =>
      runSkill({
        code: wrappedSource,
        grantedPermissions,
        hostBindings,
        input: request.input,
        timeoutMs,
      }).then((r) => r.output),
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `Skill "${manifest.id}" exceeded its declared timeout of ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timeoutHandle.unref();
    });
    raw = await Promise.race([sandboxRun, timeoutPromise]);
  } catch (e) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    endProgress(request.tenantId, invocationId);
    const code = e instanceof SkillSandboxError ? e.code : "EXECUTION_FAILED";
    const message = e instanceof Error ? e.message : String(e);
    return failureResult(
      request.tenantId,
      invocationId,
      manifest,
      code,
      message,
      Date.now() - start,
    );
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);

  // The skill may return either `output` directly or a richer envelope
  // shaped like `{ status, output, summary, followUps }`. Normalise.
  const envelope = normaliseEnvelope(raw);

  // Validate the output payload.
  const outputErrors = validateAgainstSchema(envelope.output, manifest.outputSchema);
  if (outputErrors.length > 0) {
    endProgress(request.tenantId, invocationId);
    return failureResult(
      request.tenantId,
      invocationId,
      manifest,
      "SKILL_OUTPUT_INVALID",
      `Output failed validation: ${summarise(outputErrors)}`,
      Date.now() - start,
    );
  }

  publishProgress(request.tenantId, {
    invocationId,
    skillId: manifest.id,
    fraction: 1,
    message: envelope.summary,
    at: new Date().toISOString(),
  });
  endProgress(request.tenantId, invocationId);

  return {
    status: envelope.status,
    output: envelope.output,
    summary: envelope.summary,
    followUps: envelope.followUps,
    elapsedMs: Date.now() - start,
    logs: [],
  };
}

function clampFraction(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

interface NormalisedEnvelope {
  readonly status: SkillStatus;
  readonly output: unknown;
  readonly summary: string;
  readonly followUps?: SkillResult["followUps"];
}

function normaliseEnvelope(raw: unknown): NormalisedEnvelope {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if ("output" in obj || "summary" in obj || "status" in obj) {
      const status =
        obj["status"] === "partial" || obj["status"] === "failure"
          ? (obj["status"] as SkillStatus)
          : "success";
      return {
        status,
        output: obj["output"] ?? null,
        summary: typeof obj["summary"] === "string" ? obj["summary"] : "",
        followUps: Array.isArray(obj["followUps"])
          ? (obj["followUps"] as SkillResult["followUps"])
          : undefined,
      };
    }
  }
  return { status: "success", output: raw ?? null, summary: "" };
}

function failureResult(
  tenantId: string,
  invocationId: string,
  manifest: SkillExecutionManifest,
  code: string,
  message: string,
  elapsedMs: number,
): SkillResult {
  publishProgress(tenantId, {
    invocationId,
    skillId: manifest.id,
    fraction: 1,
    message: `Failed: ${message}`,
    at: new Date().toISOString(),
  });
  endProgress(tenantId, invocationId);
  return {
    status: "failure",
    output: null,
    summary: message,
    elapsedMs,
    logs: [],
    error: { code, message },
  };
}

async function denyCallSkill(): Promise<SkillResult> {
  throw new Error(
    "callSkill is not available — this invocation was started without an inter-skill caller",
  );
}

/** Provide a SkillContext shape for documentation/tests — the actual
 *  context is built inside the sandbox; this helper is only used by
 *  Node-side callers that mock the runtime. */
export type SkillContextShape = SkillContext;
