/**
 * Skill configuration & post-install setup service (Task #43).
 *
 * Skills declare a per-field configuration schema in their manifest.
 * After install, OP shows the auto-generated configuration panel and
 * users supply values: API keys, folder paths, preferences, etc.
 *
 * Storage model:
 *   - Non-sensitive values land in `skill_configurations.values_json`
 *     (JSON object, key → primitive).
 *   - Sensitive fields (`password`, `apiKey`) are sealed via the
 *     keychain.service vault under namespace `skill-config:{skillId}`
 *     so the plaintext only exists in the OS keychain (or the
 *     AES-256-GCM file vault when the keychain backend is unavailable).
 *
 * The first-run gate (`assertSkillConfigured`) is consulted from the
 * agent loop before a skill's prompt is injected into a run.
 */
import { and, eq, or } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  skillConfigurations,
  skills,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import {
  deleteVaultEntry,
  getVaultEntry,
  putVaultEntry,
  VaultError,
} from "./keychain.service";
import { logPrivacyEvent } from "./privacy.service";

export const CONFIG_FIELD_TYPES = [
  "string",
  "password",
  "apiKey",
  "folder-path",
  "select",
  "toggle",
  "number",
  "url",
] as const;

export type ConfigFieldType = (typeof CONFIG_FIELD_TYPES)[number];

// tier-review: bounded — fixed-size literal allowlist of sensitive field types
const SENSITIVE_TYPES: ReadonlySet<ConfigFieldType> = new Set([
  "password",
  "apiKey",
]);

export interface ConfigSelectOption {
  value: string;
  label: string;
}

export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  label: string;
  description?: string;
  required: boolean;
  defaultValue?: string | number | boolean | null;
  options?: ConfigSelectOption[];
  /** RegExp source applied to string-shaped values for inline validation. */
  pattern?: string;
  /** Optional URL shown next to the field as a "learn more" link. */
  helpUrl?: string;
  /** Optional placeholder text rendered in the auto-generated input. */
  placeholder?: string;
}

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export class ConfigSchemaError extends Error {
  override readonly name = "ConfigSchemaError";
  readonly code = "CONFIG_SCHEMA_INVALID";
  constructor(message: string) {
    super(message);
  }
}

export class ConfigValueError extends Error {
  override readonly name = "ConfigValueError";
  readonly code = "CONFIG_VALUE_INVALID";
  constructor(
    message: string,
    readonly fieldKey?: string,
  ) {
    super(message);
  }
}

export class SkillNotConfiguredError extends Error {
  override readonly name = "SkillNotConfiguredError";
  readonly code = "SKILL_NOT_CONFIGURED";
  constructor(
    message: string,
    readonly skillId: string,
    readonly missingKeys: string[],
  ) {
    super(message);
  }
}

/**
 * Validate a manifest-supplied schema. Returns the canonical (sorted,
 * normalised) form on success; throws `ConfigSchemaError` on the first
 * problem so creators get one error at a time in the wizard.
 */
export function validateConfigSchema(
  raw: unknown,
): ConfigField[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigSchemaError("Configuration schema must be an array");
  }
  if (raw.length > 64) {
    throw new ConfigSchemaError("A skill may declare at most 64 config fields");
  }
  const seen = new Set<string>();
  const out: ConfigField[] = [];
  for (const entryUnknown of raw) {
    if (entryUnknown === null || typeof entryUnknown !== "object") {
      throw new ConfigSchemaError("Config field must be an object");
    }
    const entry = entryUnknown as Record<string, unknown>;
    const key = typeof entry["key"] === "string" ? entry["key"] : "";
    if (!KEY_RE.test(key)) {
      throw new ConfigSchemaError(
        `Field key "${key}" is invalid — must start with a letter and use [a-zA-Z0-9_], max 64 chars`,
      );
    }
    if (seen.has(key)) {
      throw new ConfigSchemaError(`Duplicate field key "${key}"`);
    }
    seen.add(key);
    const type = entry["type"] as ConfigFieldType;
    if (!CONFIG_FIELD_TYPES.includes(type)) {
      throw new ConfigSchemaError(
        `Field "${key}" has unsupported type "${String(entry["type"])}"`,
      );
    }
    const label = typeof entry["label"] === "string" ? entry["label"].trim() : "";
    if (!label || label.length > 200) {
      throw new ConfigSchemaError(`Field "${key}" requires a label (max 200 chars)`);
    }
    const required = entry["required"] === true;
    const field: ConfigField = { key, type, label, required };
    if (typeof entry["description"] === "string" && entry["description"].length <= 2000) {
      field.description = entry["description"];
    }
    if (typeof entry["helpUrl"] === "string" && entry["helpUrl"].length <= 2000) {
      field.helpUrl = entry["helpUrl"];
    }
    if (typeof entry["placeholder"] === "string" && entry["placeholder"].length <= 200) {
      field.placeholder = entry["placeholder"];
    }
    if (typeof entry["pattern"] === "string" && entry["pattern"].length <= 500) {
      try {
        new RegExp(entry["pattern"]);
        field.pattern = entry["pattern"];
      } catch {
        throw new ConfigSchemaError(`Field "${key}" pattern is not a valid RegExp`);
      }
    }
    if (entry["defaultValue"] !== undefined) {
      const dv = entry["defaultValue"];
      if (
        dv === null ||
        typeof dv === "string" ||
        typeof dv === "number" ||
        typeof dv === "boolean"
      ) {
        field.defaultValue = dv;
      } else {
        throw new ConfigSchemaError(
          `Field "${key}" defaultValue must be a string, number, boolean, or null`,
        );
      }
    }
    if (type === "select") {
      const opts = entry["options"];
      if (!Array.isArray(opts) || opts.length === 0) {
        throw new ConfigSchemaError(
          `Field "${key}" of type select requires a non-empty options array`,
        );
      }
      if (opts.length > 100) {
        throw new ConfigSchemaError(`Field "${key}" has too many options (max 100)`);
      }
      const cleaned: ConfigSelectOption[] = [];
      for (const optUnknown of opts) {
        if (optUnknown === null || typeof optUnknown !== "object") {
          throw new ConfigSchemaError(`Field "${key}" has a non-object option entry`);
        }
        const opt = optUnknown as Record<string, unknown>;
        const v = typeof opt["value"] === "string" ? opt["value"] : "";
        const l = typeof opt["label"] === "string" ? opt["label"] : v;
        if (!v || v.length > 200) {
          throw new ConfigSchemaError(`Field "${key}" option requires a value (max 200 chars)`);
        }
        cleaned.push({ value: v, label: l });
      }
      field.options = cleaned;
    }
    out.push(field);
  }
  return out;
}

/** Serialise a validated schema for storage. */
export function encodeConfigSchema(schema: ConfigField[]): string {
  return JSON.stringify(schema);
}

/** Parse a stored schema, defaulting to []. */
export function decodeConfigSchema(raw: string | null | undefined): ConfigField[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Re-validate to drop anything that no longer matches the contract.
    return validateConfigSchema(parsed);
  } catch (e) {
    logger.warn({ err: e }, "Failed to decode skill configuration schema — defaulting to []");
    return [];
  }
}

export interface SkillConfigField extends ConfigField {
  /** True iff the user has supplied a value (or set a secret) for this key. */
  filled: boolean;
  /** True iff the field's type is treated as sensitive and stored in the vault. */
  sensitive: boolean;
}

export interface SkillConfigStatus {
  skillId: string;
  schema: SkillConfigField[];
  /**
   * Non-sensitive values keyed by field key. Sensitive values are NEVER
   * returned over the wire — the UI only knows whether they are filled.
   */
  values: Record<string, string | number | boolean | null>;
  /** Set of sensitive field keys that have a value stored in the vault. */
  secretRefs: string[];
  required: string[];
  missingRequired: string[];
  configured: boolean;
  configuredAt: string | null;
  updatedAt: string | null;
}

interface ConfigRow {
  id: string;
  values: Record<string, string | number | boolean | null>;
  secretRefs: string[];
  configuredAt: number | null;
  updatedAt: number | null;
}

const VAULT_NAMESPACE_PREFIX = "skill-config:";
const vaultNamespace = (skillId: string) => `${VAULT_NAMESPACE_PREFIX}${skillId}`;

function parseValuesJson(raw: string): Record<string, string | number | boolean | null> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function parseSecretRefsJson(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

async function loadConfigRow(
  ctx: TenantContext,
  skillId: string,
): Promise<ConfigRow | null> {
  const rows = await db
    .select()
    .from(skillConfigurations)
    .where(
      and(
        tenantScope(ctx, skillConfigurations),
        eq(skillConfigurations.skillId, skillId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    values: parseValuesJson(row.valuesJson),
    secretRefs: parseSecretRefsJson(row.secretRefsJson),
    configuredAt: row.configuredAt,
    updatedAt: row.updatedAt,
  };
}

async function loadSkillSchema(
  ctx: TenantContext,
  skillId: string,
): Promise<{ schema: ConfigField[]; slug: string } | null> {
  const rows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.id, skillId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    schema: decodeConfigSchema(row.configurationSchema),
    slug: row.slug,
  };
}

function coerceValue(
  field: ConfigField,
  raw: unknown,
): string | number | boolean | null {
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case "toggle":
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new ConfigValueError(`Field "${field.key}" expects a boolean`, field.key);
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        throw new ConfigValueError(`Field "${field.key}" expects a number`, field.key);
      }
      return n;
    }
    case "select": {
      if (typeof raw !== "string") {
        throw new ConfigValueError(`Field "${field.key}" expects a string`, field.key);
      }
      const allowed = field.options?.some((o) => o.value === raw);
      if (!allowed) {
        throw new ConfigValueError(
          `Field "${field.key}" value "${raw}" is not in the allowed options`,
          field.key,
        );
      }
      return raw;
    }
    case "url":
    case "folder-path":
    case "string": {
      if (typeof raw !== "string") {
        throw new ConfigValueError(`Field "${field.key}" expects a string`, field.key);
      }
      if (raw.length > 4096) {
        throw new ConfigValueError(
          `Field "${field.key}" exceeds 4096 characters`,
          field.key,
        );
      }
      if (field.type === "url" && raw.length > 0) {
        try {
          new URL(raw);
        } catch {
          throw new ConfigValueError(
            `Field "${field.key}" must be a valid absolute URL`,
            field.key,
          );
        }
      }
      if (field.pattern && raw.length > 0) {
        if (!new RegExp(field.pattern).test(raw)) {
          throw new ConfigValueError(
            `Field "${field.key}" does not match the required pattern`,
            field.key,
          );
        }
      }
      return raw;
    }
    case "password":
    case "apiKey": {
      if (typeof raw !== "string") {
        throw new ConfigValueError(`Field "${field.key}" expects a string`, field.key);
      }
      if (raw.length > 4096) {
        throw new ConfigValueError(
          `Field "${field.key}" exceeds 4096 characters`,
          field.key,
        );
      }
      if (field.pattern && raw.length > 0) {
        if (!new RegExp(field.pattern).test(raw)) {
          throw new ConfigValueError(
            `Field "${field.key}" does not match the required pattern`,
            field.key,
          );
        }
      }
      return raw;
    }
  }
}

function buildStatus(
  skillId: string,
  schema: ConfigField[],
  row: ConfigRow | null,
): SkillConfigStatus {
  const values = row?.values ?? {};
  const secretRefs = new Set(row?.secretRefs ?? []);
  const projection: SkillConfigField[] = schema.map((f) => {
    const sensitive = SENSITIVE_TYPES.has(f.type);
    const filled = sensitive ? secretRefs.has(f.key) : values[f.key] !== undefined;
    return { ...f, sensitive, filled };
  });
  const required = schema.filter((f) => f.required).map((f) => f.key);
  const missingRequired = projection
    .filter((f) => f.required && !f.filled)
    .map((f) => f.key);
  return {
    skillId,
    schema: projection,
    values,
    secretRefs: Array.from(secretRefs),
    required,
    missingRequired,
    configured: missingRequired.length === 0,
    configuredAt: row?.configuredAt ? new Date(row.configuredAt).toISOString() : null,
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

/**
 * Read the current configuration status for a skill — schema + which
 * fields are filled. Sensitive plaintext is never returned here.
 */
export async function getSkillConfig(
  ctx: TenantContext,
  skillId: string,
): Promise<SkillConfigStatus | null> {
  const meta = await loadSkillSchema(ctx, skillId);
  if (!meta) return null;
  const row = await loadConfigRow(ctx, skillId);
  return buildStatus(skillId, meta.schema, row);
}

export interface SetSkillConfigInput {
  /**
   * Map of field key → value. Any key in the schema not present here is
   * treated as "leave unchanged" (use `resetSkillConfig` to wipe).
   */
  values: Record<string, unknown>;
  /**
   * Required when any sensitive field's value is being created or
   * rotated — used to seal the plaintext into the keychain vault.
   */
  masterPassword?: string;
}

/**
 * Persist a partial update to a skill's configuration. Validates every
 * supplied value against the field's declared type / options / pattern,
 * then writes non-sensitive values to the row and seals sensitive
 * values into the vault.
 */
export async function setSkillConfig(
  ctx: TenantContext,
  skillId: string,
  input: SetSkillConfigInput,
): Promise<SkillConfigStatus> {
  const meta = await loadSkillSchema(ctx, skillId);
  if (!meta) throw new ConfigValueError(`Unknown skill "${skillId}"`);

  const fieldsByKey = new Map(meta.schema.map((f) => [f.key, f]));
  const row = await loadConfigRow(ctx, skillId);
  const nextValues: Record<string, string | number | boolean | null> = {
    ...(row?.values ?? {}),
  };
  const secretRefs = new Set(row?.secretRefs ?? []);
  const sensitiveWrites: Array<{ key: string; plaintext: string }> = [];

  for (const [key, raw] of Object.entries(input.values)) {
    const field = fieldsByKey.get(key);
    if (!field) {
      throw new ConfigValueError(`Unknown configuration field "${key}"`, key);
    }
    const sensitive = SENSITIVE_TYPES.has(field.type);
    if (raw === null) {
      // Explicit clear.
      if (sensitive) {
        secretRefs.delete(key);
      } else {
        delete nextValues[key];
      }
      continue;
    }
    const coerced = coerceValue(field, raw);
    if (sensitive) {
      if (typeof coerced !== "string") {
        throw new ConfigValueError(
          `Field "${key}" must be a non-empty string`,
          key,
        );
      }
      if (coerced.length === 0) {
        secretRefs.delete(key);
      } else {
        sensitiveWrites.push({ key, plaintext: coerced });
      }
    } else {
      nextValues[key] = coerced;
    }
  }

  if (sensitiveWrites.length > 0) {
    if (!input.masterPassword) {
      throw new ConfigValueError(
        "masterPassword is required to store password / API key fields",
      );
    }
    for (const w of sensitiveWrites) {
      try {
        await putVaultEntry(ctx, {
          namespace: vaultNamespace(skillId),
          keyName: w.key,
          plaintext: w.plaintext,
          masterPassword: input.masterPassword,
        });
        secretRefs.add(w.key);
      } catch (e) {
        if (e instanceof VaultError) throw e;
        throw e;
      }
    }
  }

  const now = Date.now();
  const requiredKeys = meta.schema.filter((f) => f.required).map((f) => f.key);
  const missingAfter = requiredKeys.filter((k) => {
    const field = fieldsByKey.get(k)!;
    return SENSITIVE_TYPES.has(field.type)
      ? !secretRefs.has(k)
      : nextValues[k] === undefined;
  });
  const configuredAt =
    missingAfter.length === 0 ? row?.configuredAt ?? now : row?.configuredAt ?? null;

  if (row) {
    await db
      .update(skillConfigurations)
      .set({
        valuesJson: JSON.stringify(nextValues),
        secretRefsJson: JSON.stringify(Array.from(secretRefs)),
        configuredAt,
        updatedAt: now,
      })
      .where(eq(skillConfigurations.id, row.id));
  } else {
    await db.insert(skillConfigurations).values(
      withTenantValues(ctx, {
        id: `cfg_${nanoid()}`,
        skillId,
        valuesJson: JSON.stringify(nextValues),
        secretRefsJson: JSON.stringify(Array.from(secretRefs)),
        configuredAt,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  await logPrivacyEvent(ctx, {
    eventType: "skill.config.update",
    actor: ctx.userId ?? ctx.tenantId,
    target: skillId,
    severity: "info",
    detail: `slug=${meta.slug} fields=${Object.keys(input.values).length} secrets=${sensitiveWrites.length}`,
  });

  const status = buildStatus(
    skillId,
    meta.schema,
    await loadConfigRow(ctx, skillId),
  );
  return status;
}

/**
 * Wipe every value (vault entries included) for a skill — the "reset to
 * defaults" button on the configuration panel.
 */
export async function resetSkillConfig(
  ctx: TenantContext,
  skillId: string,
): Promise<SkillConfigStatus> {
  const meta = await loadSkillSchema(ctx, skillId);
  if (!meta) throw new ConfigValueError(`Unknown skill "${skillId}"`);
  const row = await loadConfigRow(ctx, skillId);
  if (row) {
    for (const key of row.secretRefs) {
      try {
        await deleteVaultEntry(ctx, vaultNamespace(skillId), key);
      } catch (e) {
        logger.warn(
          { err: e, skillId, key },
          "Failed to clear vault entry during skill config reset",
        );
      }
    }
    await db
      .delete(skillConfigurations)
      .where(eq(skillConfigurations.id, row.id));
  }
  await logPrivacyEvent(ctx, {
    eventType: "skill.config.reset",
    actor: ctx.userId ?? ctx.tenantId,
    target: skillId,
    severity: "info",
    detail: `slug=${meta.slug}`,
  });
  return buildStatus(skillId, meta.schema, null);
}

/**
 * Resolve a single sensitive value back to plaintext. Used by skill
 * runtimes (Task #51) — never exposed to the HTTP layer.
 */
export async function readSkillSecret(
  ctx: TenantContext,
  skillId: string,
  fieldKey: string,
  masterPassword: string,
): Promise<string> {
  return getVaultEntry(ctx, vaultNamespace(skillId), fieldKey, masterPassword);
}

/**
 * The first-run gate: throw `SkillNotConfiguredError` when the skill has
 * required fields that are not yet filled. Called from the agent loop
 * before a skill prompt is injected.
 */
export async function assertSkillConfigured(
  ctx: TenantContext,
  skillId: string,
): Promise<void> {
  const status = await getSkillConfig(ctx, skillId);
  if (!status) return; // Skill itself is missing — caller will handle.
  if (status.missingRequired.length === 0) return;
  throw new SkillNotConfiguredError(
    `Skill requires configuration before it can run: ${status.missingRequired.join(", ")}`,
    skillId,
    status.missingRequired,
  );
}

export interface BulkConfigTemplateEntry {
  /** Match by skill slug (preferred — portable across workspaces). */
  slug?: string;
  /** Or by skill id when known. */
  skillId?: string;
  values: Record<string, unknown>;
}

export interface BulkConfigTemplate {
  omninityConfigTemplateVersion: 1;
  entries: BulkConfigTemplateEntry[];
}

export interface BulkConfigImportResult {
  applied: Array<{ skillId: string; slug: string; configured: boolean }>;
  skipped: Array<{ slug: string | null; skillId: string | null; reason: string }>;
}

/**
 * Apply a configuration template across multiple skills — the
 * enterprise pre-configuration flow. Each entry is best-effort; one
 * failed entry does not abort the rest.
 */
export async function bulkImportSkillConfig(
  ctx: TenantContext,
  template: BulkConfigTemplate,
  masterPassword?: string,
): Promise<BulkConfigImportResult> {
  if (template.omninityConfigTemplateVersion !== 1) {
    throw new ConfigValueError(
      `Unsupported template version: ${template.omninityConfigTemplateVersion}`,
    );
  }
  if (!Array.isArray(template.entries)) {
    throw new ConfigValueError("Template entries must be an array");
  }
  const applied: BulkConfigImportResult["applied"] = [];
  const skipped: BulkConfigImportResult["skipped"] = [];

  // Pre-load every named skill in one query.
  const slugs = template.entries
    .map((e) => e.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const ids = template.entries
    .map((e) => e.skillId)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const lookup = new Map<string, { id: string; slug: string }>();
  if (slugs.length > 0 || ids.length > 0) {
    const matches = await db
      .select({ id: skills.id, slug: skills.slug })
      .from(skills)
      .where(and(tenantScope(ctx, skills)));
    for (const m of matches) {
      if (slugs.includes(m.slug)) lookup.set(`slug:${m.slug}`, m);
      if (ids.includes(m.id)) lookup.set(`id:${m.id}`, m);
    }
  }
  void or;

  for (const entry of template.entries) {
    const idKey = entry.skillId ? "id:" + entry.skillId : null;
    const slugKey = entry.slug ? "slug:" + entry.slug : null;
    const ref =
      (idKey && lookup.get(idKey)) ||
      (slugKey && lookup.get(slugKey)) ||
      null;
    if (!ref) {
      skipped.push({
        slug: entry.slug ?? null,
        skillId: entry.skillId ?? null,
        reason: "Skill not found in this workspace",
      });
      continue;
    }
    try {
      const setInput: SetSkillConfigInput = { values: entry.values };
      if (masterPassword !== undefined) setInput.masterPassword = masterPassword;
      const status = await setSkillConfig(ctx, ref.id, setInput);
      applied.push({
        skillId: ref.id,
        slug: ref.slug,
        configured: status.configured,
      });
    } catch (e) {
      skipped.push({
        slug: ref.slug,
        skillId: ref.id,
        reason: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  await logPrivacyEvent(ctx, {
    eventType: "skill.config.bulk_import",
    actor: ctx.userId ?? ctx.tenantId,
    target: "*",
    severity: "info",
    detail: `applied=${applied.length} skipped=${skipped.length}`,
  });
  return { applied, skipped };
}

/** Lookup helper used by tests + admin tools — not exported in the bundle. */
export async function _loadConfigRowForTests(
  ctx: TenantContext,
  skillId: string,
): Promise<ConfigRow | null> {
  return loadConfigRow(ctx, skillId);
}

