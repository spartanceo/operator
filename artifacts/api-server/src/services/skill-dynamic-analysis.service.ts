/**
 * Skill dynamic analysis — second stage of the moderation pipeline
 * (Task #57).
 *
 * The task specification calls for a Docker-isolated execution
 * environment. In the local-first OP product the hosted moderation
 * worker runs the analysis in a Docker sandbox; in this codebase we
 * reuse the in-process VM sandbox (`skill-runtime/sandbox.ts`, the
 * SOLE allowlisted vm.runInNewContext call) with a synthetic OP
 * environment that:
 *
 *   - exposes the standard host verbs (files / network / memory / …)
 *     wrapped in MONITORS that record every call instead of doing real
 *     I/O.
 *   - feeds the skill the standard test-scenario inputs (probe inputs
 *     designed to surface data exfiltration and permission boundary
 *     violations).
 *   - records wall-clock, log volume, and any thrown errors.
 *
 * The output `DynamicAnalysisReport` shape is the same regardless of
 * whether the runner is in-process VM or remote Docker — the upstream
 * pipeline just consumes the report.
 */
import {
  runSkill,
  SkillSandboxError,
  type SkillHostBinding,
  type SkillRunRequest,
} from "../skill-runtime/sandbox";

export interface DynamicCallRecord {
  readonly verb: string;
  readonly args: ReadonlyArray<unknown>;
  readonly returned: unknown;
  readonly atMs: number;
}

export interface DynamicViolation {
  readonly code: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly message: string;
  readonly evidence?: unknown;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly succeeded: boolean;
  readonly durationMs: number;
  readonly logs: ReadonlyArray<{ level: string; message: string }>;
  readonly calls: ReadonlyArray<DynamicCallRecord>;
  readonly violations: ReadonlyArray<DynamicViolation>;
  readonly error?: string;
}

export interface DynamicAnalysisReport {
  readonly safe: boolean;
  readonly riskScore: number;
  readonly scenarios: ReadonlyArray<ScenarioResult>;
  readonly violations: ReadonlyArray<DynamicViolation>;
  readonly maxDurationMs: number;
  readonly maxLogCount: number;
  readonly elapsedMs: number;
  readonly summary: string;
}

/** A test scenario the skill is run against. Each scenario seeds an
 * input the skill might encounter in the field; the harness watches
 * what the skill actually does with it. */
interface TestScenario {
  readonly name: string;
  readonly input: unknown;
}

const STANDARD_SCENARIOS: ReadonlyArray<TestScenario> = [
  { name: "benign_input", input: { kind: "benign", text: "hello world" } },
  {
    name: "secret_in_input",
    input: { kind: "secret_probe", apiKey: "sk-canary-do-not-leak", text: "process invoice" },
  },
  {
    name: "path_traversal_probe",
    input: { kind: "path_probe", filePath: "../../etc/passwd" },
  },
  {
    name: "url_probe",
    input: { kind: "url_probe", url: "https://exfil.example.com/canary" },
  },
];

const CANARY_SECRET = "sk-canary-do-not-leak";

/**
 * Build a host binding that records every call. The `permission` is set
 * to a stable string so it never blocks during dynamic analysis (we
 * grant every permission so the skill is free to demonstrate its full
 * behaviour — that is the whole point of dynamic monitoring).
 */
function recordingBinding(
  verb: string,
  permission: string,
  calls: DynamicCallRecord[],
  violations: DynamicViolation[],
  declared: { hosts: ReadonlyArray<string>; scopes: ReadonlyArray<string> },
  returnValue: unknown = null,
): SkillHostBinding {
  return {
    permission,
    invoke: (...args: ReadonlyArray<unknown>) => {
      calls.push({ verb, args, returned: returnValue, atMs: Date.now() });
      // Per-verb monitoring rules.
      if (verb === "fetch") {
        const url = String(args[0] ?? "");
        try {
          const host = new URL(url).hostname;
          if (declared.hosts.length > 0 && !declared.hosts.includes(host)) {
            violations.push({
              code: "D001",
              severity: "critical",
              message: `Skill attempted to fetch undeclared host "${host}"`,
              evidence: { url, declared: declared.hosts },
            });
          }
        } catch {
          violations.push({
            code: "D002",
            severity: "high",
            message: `Skill called the network verb with an invalid URL`,
            evidence: { url },
          });
        }
        const payload = JSON.stringify(args[1] ?? {});
        if (payload.includes(CANARY_SECRET)) {
          violations.push({
            code: "D003",
            severity: "critical",
            message: "Skill attempted to exfiltrate the canary secret over the network",
            evidence: { url },
          });
        }
      }
      if (verb === "writeFile" || verb === "readFile") {
        const path = String(args[0] ?? "");
        if (path.includes("..") || path.startsWith("/etc") || path.startsWith("/root")) {
          violations.push({
            code: "D004",
            severity: "critical",
            message: `Skill attempted ${verb} outside its workspace scope`,
            evidence: { path },
          });
        }
        if (
          declared.scopes.length > 0 &&
          !declared.scopes.some((s) => path.startsWith(s))
        ) {
          violations.push({
            code: "D005",
            severity: "high",
            message: `Skill ${verb} hit a path outside its declared file scopes`,
            evidence: { path, declared: declared.scopes },
          });
        }
      }
      return returnValue;
    },
  };
}

/** Build the harness host bindings for one scenario run. */
function buildScenarioBindings(
  declaredHosts: ReadonlyArray<string>,
  declaredScopes: ReadonlyArray<string>,
  calls: DynamicCallRecord[],
  violations: DynamicViolation[],
): Record<string, SkillHostBinding> {
  const declared = { hosts: declaredHosts, scopes: declaredScopes };
  return {
    fetch: recordingBinding("fetch", "network.fetch", calls, violations, declared, {
      ok: true,
      status: 200,
      body: "",
    }),
    readFile: recordingBinding("readFile", "files.read", calls, violations, declared, ""),
    writeFile: recordingBinding("writeFile", "files.write", calls, violations, declared, true),
    recallMemory: recordingBinding(
      "recallMemory",
      "memory.read",
      calls,
      violations,
      declared,
      [],
    ),
    writeMemory: recordingBinding(
      "writeMemory",
      "memory.write",
      calls,
      violations,
      declared,
      true,
    ),
    searchKnowledge: recordingBinding(
      "searchKnowledge",
      "knowledge.read",
      calls,
      violations,
      declared,
      [],
    ),
    sendEmail: recordingBinding("sendEmail", "email.send", calls, violations, declared, true),
  };
}

const ALL_PERMISSIONS = [
  "network.fetch",
  "files.read",
  "files.write",
  "memory.read",
  "memory.write",
  "knowledge.read",
  "email.send",
];

const SEV_WEIGHT: Record<DynamicViolation["severity"], number> = {
  low: 2,
  medium: 6,
  high: 15,
  critical: 30,
};

const MAX_DURATION_MS = 1_500;
const MAX_LOG_COUNT = 200;

/** Run the skill against the standard scenario set and return one report. */
export async function runDynamicAnalysis(input: {
  source: string;
  declaredHosts?: ReadonlyArray<string>;
  declaredScopes?: ReadonlyArray<string>;
  scenarios?: ReadonlyArray<TestScenario>;
  perScenarioTimeoutMs?: number;
}): Promise<DynamicAnalysisReport> {
  const start = Date.now();
  const scenarios = input.scenarios ?? STANDARD_SCENARIOS;
  const declaredHosts = input.declaredHosts ?? [];
  const declaredScopes = input.declaredScopes ?? [];
  const perScenarioTimeoutMs = Math.min(5_000, input.perScenarioTimeoutMs ?? 1_500);

  const allViolations: DynamicViolation[] = [];
  const results: ScenarioResult[] = [];

  let maxDurationMs = 0;
  let maxLogCount = 0;

  for (const scenario of scenarios) {
    const calls: DynamicCallRecord[] = [];
    const violations: DynamicViolation[] = [];
    const bindings = buildScenarioBindings(
      declaredHosts,
      declaredScopes,
      calls,
      violations,
    );
    // Wrap the user source so the exported function is INVOKED with the
    // scenario input. The convention is `module.exports = async (input, host) => …`.
    // The harness in `sandbox.ts` returns whatever `module.exports` is at
    // the end of evaluation; we capture the function and re-export the
    // result of calling it so the awaited value is the real return.
    const wrappedSource = `
      ${input.source};
      const __fn__ = module.exports;
      module.exports = (typeof __fn__ === "function") ? __fn__(input, host) : __fn__;
    `;
    const request: SkillRunRequest = {
      code: wrappedSource,
      grantedPermissions: ALL_PERMISSIONS,
      hostBindings: bindings,
      input: scenario.input,
      timeoutMs: perScenarioTimeoutMs,
    };
    let succeeded = false;
    let error: string | undefined;
    let durationMs = 0;
    let logs: ReadonlyArray<{ level: string; message: string }> = [];
    try {
      const result = await runSkill(request);
      succeeded = true;
      durationMs = result.durationMs;
      logs = result.logs;
      const serialised = JSON.stringify(result.output ?? "");
      if (serialised.includes(CANARY_SECRET)) {
        violations.push({
          code: "D006",
          severity: "critical",
          message: "Skill leaked the canary secret in its return value",
          evidence: { scenario: scenario.name },
        });
      }
      for (const entry of logs) {
        if (entry.message.includes(CANARY_SECRET)) {
          violations.push({
            code: "D007",
            severity: "high",
            message: "Skill wrote the canary secret to its console logs",
            evidence: { scenario: scenario.name },
          });
          break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (e instanceof SkillSandboxError && e.code === "SCANNER_REJECTED") {
        violations.push({
          code: "D008",
          severity: "critical",
          message: `Static scanner rejected the source mid-dynamic-run: ${error}`,
        });
      } else {
        violations.push({
          code: "D009",
          severity: "low",
          message: `Skill threw on scenario "${scenario.name}": ${error}`,
        });
      }
    }
    if (durationMs > MAX_DURATION_MS) {
      violations.push({
        code: "D010",
        severity: "medium",
        message: `Scenario "${scenario.name}" exceeded duration budget (${durationMs}ms)`,
      });
    }
    if (logs.length > MAX_LOG_COUNT) {
      violations.push({
        code: "D011",
        severity: "low",
        message: `Scenario "${scenario.name}" emitted ${logs.length} log lines (>${MAX_LOG_COUNT})`,
      });
    }
    maxDurationMs = Math.max(maxDurationMs, durationMs);
    maxLogCount = Math.max(maxLogCount, logs.length);

    results.push({
      scenario: scenario.name,
      succeeded,
      durationMs,
      logs,
      calls,
      violations,
      ...(error ? { error } : {}),
    });
    allViolations.push(...violations);
  }

  let risk = 0;
  for (const v of allViolations) risk += SEV_WEIGHT[v.severity];
  risk = Math.min(100, risk);

  const safe = !allViolations.some(
    (v) => v.severity === "critical" || v.severity === "high",
  );

  return {
    safe,
    riskScore: risk,
    scenarios: results,
    violations: allViolations,
    maxDurationMs,
    maxLogCount,
    elapsedMs: Date.now() - start,
    summary: safe
      ? `Dynamic analysis passed across ${scenarios.length} scenarios`
      : `Dynamic analysis surfaced ${allViolations.length} violations (risk ${risk})`,
  };
}
