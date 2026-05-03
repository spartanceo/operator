/**
 * Skill Execution Contract — Task #39.
 *
 * Defines the formal input/output shape every skill in the Omninity
 * Operator marketplace must conform to. The runtime in
 * `artifacts/api-server/src/skill-runtime/` is the authoritative
 * implementation; these types are the boundary that marketplace skills,
 * the creator dashboard, and the CLI test runner all agree on.
 *
 * Three layers, each with one canonical shape:
 *
 *   1. SkillExecutionManifest — declarative descriptor that ships with
 *      every skill (validated at publish + install time).
 *   2. SkillContext — handed to the skill at invocation time. Carries
 *      typed input, the host-binding proxy (`tools`), the inter-skill
 *      caller (`callSkill`), the live progress reporter, the memory
 *      access token, and the deadline.
 *   3. SkillResult — what the skill returns. Always has a `status`,
 *      structured `output`, a human-readable `summary`, optional
 *      follow-up suggestions, and the elapsed time / log buffer the
 *      runtime captured.
 */

/** The verbs a skill may declare as required permissions. */
export type SkillPermission =
  | "filesystem:read"
  | "filesystem:write"
  | "network:fetch"
  | "ollama:invoke"
  | "clipboard:read"
  | "clipboard:write"
  | "shell:execute"
  | "memory:read"
  | "memory:write"
  | "skills:invoke";

/**
 * A minimal subset of JSON Schema sufficient to drive the auto-generated
 * invocation UI and to validate skill input/output. We intentionally do
 * NOT depend on a third-party JSON Schema engine — the validator in
 * `manifest.ts` understands this exact subset and rejects anything
 * outside it. Keeping the schema language small keeps the contract
 * decidable and the marketplace UI predictable.
 */
export interface SkillJsonSchema {
  readonly type:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "object"
    | "array"
    | "null";
  readonly description?: string;
  readonly enum?: ReadonlyArray<string | number | boolean | null>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly properties?: Readonly<Record<string, SkillJsonSchema>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
  readonly items?: SkillJsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly default?: unknown;
}

/**
 * A reusable test case authored in the manifest. The CLI command
 * `op skill test` and the creator-dashboard "Run tests" button both
 * execute these against the live skill source and assert the output
 * matches.
 */
export interface SkillTestCase {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /**
   * Strict deep equality match against `SkillResult.output`. Use either
   * `expectedOutput` OR `expectedSummaryIncludes` (or both) — at least
   * one must be present.
   */
  readonly expectedOutput?: unknown;
  /** Substring that must appear in `SkillResult.summary`. */
  readonly expectedSummaryIncludes?: string;
  /** Expected terminal status. Defaults to "success". */
  readonly expectedStatus?: SkillStatus;
  /** Per-test timeout override in ms (default = manifest.timeoutMs). */
  readonly timeoutMs?: number;
}

export interface SkillExecutionManifest {
  /** Wire-format pin so a future incompatible manifest shape can fork. */
  readonly omninitySkillContractVersion: 1;
  /** Slug-shaped id, unique within a tenant. */
  readonly id: string;
  /** Semantic version of the skill (NOT of the contract). */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /** Schema that drives the auto-generated invocation UI. */
  readonly inputSchema: SkillJsonSchema;
  /** Schema the runtime validates the SkillResult.output against. */
  readonly outputSchema: SkillJsonSchema;
  /** Permission verbs the skill is allowed to invoke via `context.tools`. */
  readonly permissions: ReadonlyArray<SkillPermission>;
  /**
   * Names of host-bound tool verbs the skill expects. Each must map to a
   * permission in `permissions` — the validator enforces the link.
   */
  readonly requiredTools: ReadonlyArray<string>;
  /**
   * Other skills (by id) this skill calls via `context.callSkill(...)`.
   * Used by the publish-time cycle detector.
   */
  readonly requiredSkills?: ReadonlyArray<string>;
  /** Minimum OP server version required (semver). */
  readonly minOpVersion: string;
  /**
   * Constraints on the model the host must select before invoking the
   * skill. The runtime forwards these to the model selector.
   */
  readonly modelRequirements?: {
    readonly minContextTokens?: number;
    readonly familyIncludes?: ReadonlyArray<string>;
  };
  /** Wall-clock budget per invocation in ms. Capped at 60s by the runtime. */
  readonly timeoutMs: number;
  /** Optional manifest-authored test cases (`op skill test`). */
  readonly testCases?: ReadonlyArray<SkillTestCase>;
}

export type SkillStatus = "success" | "partial" | "failure";

/** Levels accepted by the in-skill `console`. */
export type SkillLogLevel = "info" | "warn" | "error";

/** Single progress event published via `context.report(...)`. */
export interface SkillProgressEvent {
  readonly invocationId: string;
  readonly skillId: string;
  /** Monotonic 0..1 fraction; clamped by the runtime. */
  readonly fraction: number;
  readonly message: string;
  /** Wall-clock UTC ISO. */
  readonly at: string;
}

/**
 * Per-invocation context the sandbox passes to the skill. Carries the
 * tenant context, sandboxed logger, `tools` proxy, `callSkill` for
 * inter-skill composition, the progress reporter, and the deadline.
 */
export interface SkillContext {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly invocationId: string;
  readonly skillId: string;
  /** Unix-millis deadline; the runtime enforces it. */
  readonly deadline: number;
  /** Validated input, shaped by `manifest.inputSchema`. */
  readonly input: unknown;
  /**
   * Opaque token the skill passes back to memory APIs to identify
   * itself. The host service trades it for a scoped repository.
   */
  readonly memoryToken: string;
  /** Reports progress to the chat UI via the in-process bus. */
  readonly report: (fraction: number, message: string) => void;
  /** Sandboxed logger; bounded buffer kept on the SkillResult. */
  readonly log: (level: SkillLogLevel, message: string) => void;
  /**
   * Names of host tool verbs the skill is allowed to call. The runtime
   * adds an actual proxy as `tools[verb](...)` in the sandbox globals.
   */
  readonly availableTools: ReadonlyArray<string>;
}

export interface SkillFollowUp {
  readonly title: string;
  readonly skillId?: string;
  readonly input?: Record<string, unknown>;
}

export interface SkillResult {
  readonly status: SkillStatus;
  /** Validated against `manifest.outputSchema`. */
  readonly output: unknown;
  /** Human-readable one-liner shown in the chat after completion. */
  readonly summary: string;
  readonly followUps?: ReadonlyArray<SkillFollowUp>;
  readonly elapsedMs: number;
  readonly logs: ReadonlyArray<{ level: SkillLogLevel; message: string }>;
  /** Populated when status === "failure". */
  readonly error?: { code: string; message: string };
}
