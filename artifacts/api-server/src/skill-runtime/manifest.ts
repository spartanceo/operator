/**
 * Skill manifest schema + validator (Task #39).
 *
 * Every skill ships with a `SkillExecutionManifest` (defined in
 * `@workspace/types`). This module implements:
 *
 *   1. `ManifestSchema` — a Zod schema that mirrors the contract one-to-one
 *      and is used at publish time, install time, and inside the CLI test
 *      runner. Malformed manifests are rejected before they reach users.
 *   2. `validateAgainstSchema(value, schema)` — a small JSON Schema engine
 *      sufficient to validate skill input/output against the subset of
 *      JSON Schema declared in `SkillJsonSchema`. Keeping the engine in
 *      this file (instead of importing ajv) means the contract surface is
 *      fully visible to reviewers and the bundle stays lean.
 *   3. `assertManifestInternalConsistency(manifest)` — checks that
 *      `requiredTools` references only verbs whose permission appears in
 *      `permissions`, that `timeoutMs` is within the runtime cap, etc.
 *      Surfaces a `ManifestValidationError` with the offending path.
 */
import type {
  SkillExecutionManifest,
  SkillJsonSchema,
  SkillPermission,
} from "@workspace/types";
import { z } from "zod";

export class ManifestValidationError extends Error {
  override readonly name = "ManifestValidationError";
  readonly code = "MANIFEST_VALIDATION";
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
  }
}

/** Wall-clock cap the runtime enforces on every skill invocation. */
export const MAX_SKILL_TIMEOUT_MS = 60_000;

const PERMISSIONS: ReadonlyArray<SkillPermission> = [
  "filesystem:read",
  "filesystem:write",
  "network:fetch",
  "ollama:invoke",
  "clipboard:read",
  "clipboard:write",
  "shell:execute",
  "memory:read",
  "memory:write",
  "skills:invoke",
];

const PermissionSchema = z.enum(
  PERMISSIONS as unknown as [SkillPermission, ...SkillPermission[]],
);

const SemverPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const IdPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;

// JSON Schema is recursive — declare via `z.lazy`.
export const JsonSchema: z.ZodType<SkillJsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "string",
        "number",
        "integer",
        "boolean",
        "object",
        "array",
        "null",
      ]),
      description: z.string().max(2_000).optional(),
      enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      pattern: z.string().max(500).optional(),
      properties: z.record(z.string(), JsonSchema).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.boolean().optional(),
      items: JsonSchema.optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      default: z.unknown().optional(),
    })
    .strict() as unknown as z.ZodType<SkillJsonSchema>,
);

const TestCaseSchema = z.object({
  name: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()),
  expectedOutput: z.unknown().optional(),
  expectedSummaryIncludes: z.string().min(1).max(500).optional(),
  expectedStatus: z.enum(["success", "partial", "failure"]).optional(),
  timeoutMs: z.number().int().positive().max(MAX_SKILL_TIMEOUT_MS).optional(),
});

export const ManifestSchema = z
  .object({
    omninitySkillContractVersion: z.literal(1),
    id: z.string().regex(IdPattern, "must be a slug (lowercase letters, digits, hyphens)"),
    version: z.string().regex(SemverPattern, "must be a semver like 1.2.3"),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    permissions: z.array(PermissionSchema).max(20),
    requiredTools: z.array(z.string().min(1).max(80)).max(40),
    requiredSkills: z.array(z.string().regex(IdPattern)).max(20).optional(),
    minOpVersion: z.string().regex(SemverPattern),
    modelRequirements: z
      .object({
        minContextTokens: z.number().int().positive().optional(),
        familyIncludes: z.array(z.string().min(1).max(80)).max(20).optional(),
      })
      .optional(),
    timeoutMs: z.number().int().positive().max(MAX_SKILL_TIMEOUT_MS),
    testCases: z.array(TestCaseSchema).max(50).optional(),
  })
  .strict();

/**
 * Map a verb to the permission it requires. Verbs not listed here are
 * unrecognised and rejected by `assertManifestInternalConsistency`.
 */
export const TOOL_VERB_PERMISSIONS: Readonly<Record<string, SkillPermission>> = {
  fileRead: "filesystem:read",
  fileWrite: "filesystem:write",
  fetch: "network:fetch",
  llm: "ollama:invoke",
  clipboardRead: "clipboard:read",
  clipboardWrite: "clipboard:write",
  shell: "shell:execute",
  memoryRead: "memory:read",
  memoryWrite: "memory:write",
  callSkill: "skills:invoke",
};

/**
 * Cross-field checks the Zod schema cannot express. Throws on the first
 * violation so the caller surfaces a single clear error to the user.
 */
export function assertManifestInternalConsistency(
  manifest: SkillExecutionManifest,
): void {
  const permSet = new Set(manifest.permissions);
  for (const verb of manifest.requiredTools) {
    const perm = TOOL_VERB_PERMISSIONS[verb];
    if (!perm) {
      throw new ManifestValidationError(
        `Unknown tool verb "${verb}" — see TOOL_VERB_PERMISSIONS`,
        "requiredTools",
      );
    }
    if (!permSet.has(perm)) {
      throw new ManifestValidationError(
        `Tool "${verb}" requires permission "${perm}" but it is not declared in permissions`,
        "requiredTools",
      );
    }
  }
  if (manifest.requiredSkills && manifest.requiredSkills.length > 0) {
    if (!permSet.has("skills:invoke")) {
      throw new ManifestValidationError(
        `Manifest declares requiredSkills but is missing the "skills:invoke" permission`,
        "permissions",
      );
    }
    if (manifest.requiredSkills.includes(manifest.id)) {
      throw new ManifestValidationError(
        `A skill cannot list itself in requiredSkills`,
        "requiredSkills",
      );
    }
  }
  for (const tc of manifest.testCases ?? []) {
    if (
      tc.expectedOutput === undefined &&
      tc.expectedSummaryIncludes === undefined &&
      tc.expectedStatus === undefined
    ) {
      throw new ManifestValidationError(
        `Test "${tc.name}" must declare at least one expectation`,
        "testCases",
      );
    }
  }
}

/** Parse, validate, and consistency-check a manifest in one shot. */
export function parseManifest(raw: unknown): SkillExecutionManifest {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") ?? "(root)";
    throw new ManifestValidationError(
      issue?.message ?? "invalid manifest",
      path || "(root)",
    );
  }
  // Zod's strict() + recursive lazy() loses the typed inference; cast
  // back to the canonical shape after schema validation passes.
  const manifest = parsed.data as unknown as SkillExecutionManifest;
  assertManifestInternalConsistency(manifest);
  return manifest;
}

// ─────────────── Tiny JSON Schema validator ───────────────────────────

export interface JsonSchemaError {
  readonly path: string;
  readonly message: string;
}

/**
 * Validate `value` against `schema` (the SkillJsonSchema subset). Returns
 * the list of errors (empty = valid). Used by the executor to validate
 * skill input before invocation and skill output before returning.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: SkillJsonSchema,
): ReadonlyArray<JsonSchemaError> {
  const errors: JsonSchemaError[] = [];
  walk(value, schema, "", errors);
  return errors;
}

function walk(
  value: unknown,
  schema: SkillJsonSchema,
  path: string,
  errors: JsonSchemaError[],
): void {
  const t = schema.type;
  // Type check
  const ok = checkType(value, t);
  if (!ok) {
    errors.push({ path: path || "(root)", message: `expected ${t}` });
    return;
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({
      path: path || "(root)",
      message: `must be one of ${JSON.stringify(schema.enum)}`,
    });
  }
  if (t === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `length < ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `length > ${schema.maxLength}` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match /${schema.pattern}/` });
    }
  }
  if ((t === "number" || t === "integer") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `< ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `> ${schema.maximum}` });
    }
  }
  if (t === "object" && value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in obj)) {
        errors.push({
          path: joinPath(path, required),
          message: "is required",
        });
      }
    }
    if (schema.properties) {
      for (const [k, child] of Object.entries(schema.properties)) {
        if (k in obj) walk(obj[k], child, joinPath(path, k), errors);
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(obj)) {
          if (!(k in schema.properties)) {
            errors.push({
              path: joinPath(path, k),
              message: "additional property not allowed",
            });
          }
        }
      }
    }
  }
  if (t === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `fewer than ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `more than ${schema.maxItems} items` });
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], schema.items, `${path}[${i}]`, errors);
      }
    }
  }
}

function checkType(value: unknown, type: SkillJsonSchema["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
  }
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
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
