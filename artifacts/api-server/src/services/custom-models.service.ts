/**
 * Custom models, LoRA adapters, workspace assignments, skill adapter
 * preferences, and the enterprise model distribution registry (Task #47).
 *
 * Registration of GGUF models and LoRA adapters is metadata-only — we
 * never copy the binary file, only record the path the user pointed us
 * at plus a SHA-256 fingerprint computed at registration time. The
 * runtime adapter (Ollama, llama.cpp, etc.) is responsible for actually
 * loading the file when inference begins.
 *
 * Compatibility check for adapters: the supplied `baseModel` must match
 * either a registered custom model name or a non-empty string the
 * caller asserts is a runtime-known model. We reject empty / whitespace
 * base-model values with a structured error so the UI can surface a
 * clear "incompatible adapter" message.
 *
 * Every write goes through `tenantScope` / `withTenantValues` so cross-
 * tenant access is impossible.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  customModels,
  db,
  enterpriseModelDistributions,
  loraAdapters,
  skillAdapterPreferences,
  tenantScope,
  withTenantValues,
  workspaceAdapterAssignments,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { getOrCreateOrg } from "./enterprise-admin.service";

export class CustomModelError extends Error {
  override readonly name = "CustomModelError";
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ModelStatus = "active" | "disabled";

export interface CustomModelRow {
  id: string;
  name: string;
  displayName: string;
  description: string;
  filePath: string;
  fileSize: number;
  format: string;
  architecture: string;
  parameterCount: string;
  quantization: string;
  sha256: string;
  status: ModelStatus;
  source: string;
  importedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoraAdapterRow {
  id: string;
  name: string;
  displayName: string;
  description: string;
  baseModel: string;
  filePath: string;
  fileSize: number;
  format: string;
  rank: number;
  alpha: number;
  sha256: string;
  status: ModelStatus;
  source: string;
  importedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAdapterAssignmentRow {
  id: string;
  workspaceId: string;
  baseModel: string;
  adapterId: string | null;
  adapterName: string | null;
  updatedAt: string;
}

export interface SkillAdapterPreferenceRow {
  id: string;
  skillSlug: string;
  baseModel: string;
  adapterName: string;
  updatedAt: string;
}

export interface EnterpriseModelDistributionRow {
  id: string;
  kind: "model" | "adapter";
  name: string;
  displayName: string;
  description: string;
  baseModel: string;
  sourcePath: string;
  fileSize: number;
  sha256: string;
  status: "pending" | "approved" | "rejected";
  approvedBy: string;
  approvedAt: string | null;
  rejectionReason: string;
  createdAt: string;
  updatedAt: string;
}

const VALID_NAME = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function validateName(value: string, field: string): string {
  const trimmed = value.trim();
  if (!VALID_NAME.test(trimmed)) {
    throw new CustomModelError(
      "INVALID_NAME",
      `${field} must be 1–128 chars of letters, digits, '.', '_', ':' or '-'`,
    );
  }
  return trimmed;
}

async function fingerprintFile(
  filePath: string,
  expectedExtensions: readonly string[],
): Promise<{ size: number; sha256: string }> {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  if (expectedExtensions.length > 0 && !expectedExtensions.includes(ext)) {
    throw new CustomModelError(
      "INVALID_FORMAT",
      `file must have one of these extensions: ${expectedExtensions.join(", ")}`,
    );
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new CustomModelError(
      "FILE_NOT_FOUND",
      `cannot read file at "${filePath}"`,
    );
  }
  if (!stat.isFile()) {
    throw new CustomModelError(
      "NOT_A_FILE",
      `"${filePath}" is not a regular file`,
    );
  }
  const handle = await fs.open(filePath, "r");
  try {
    const hash = createHash("sha256");
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return { size: stat.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

function customModelToRow(
  r: typeof customModels.$inferSelect,
): CustomModelRow {
  return {
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    filePath: r.filePath,
    fileSize: r.fileSize,
    format: r.format,
    architecture: r.architecture,
    parameterCount: r.parameterCount,
    quantization: r.quantization,
    sha256: r.sha256,
    status: (r.status === "disabled" ? "disabled" : "active") as ModelStatus,
    source: r.source,
    importedBy: r.importedBy,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function loraAdapterToRow(
  r: typeof loraAdapters.$inferSelect,
): LoraAdapterRow {
  return {
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    baseModel: r.baseModel,
    filePath: r.filePath,
    fileSize: r.fileSize,
    format: r.format,
    rank: r.rank,
    alpha: r.alpha,
    sha256: r.sha256,
    status: (r.status === "disabled" ? "disabled" : "active") as ModelStatus,
    source: r.source,
    importedBy: r.importedBy,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function distributionToRow(
  r: typeof enterpriseModelDistributions.$inferSelect,
): EnterpriseModelDistributionRow {
  return {
    id: r.id,
    kind: (r.kind === "adapter" ? "adapter" : "model"),
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    baseModel: r.baseModel,
    sourcePath: r.sourcePath,
    fileSize: r.fileSize,
    sha256: r.sha256,
    status: (r.status === "approved"
      ? "approved"
      : r.status === "rejected"
        ? "rejected"
        : "pending"),
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt ? new Date(r.approvedAt).toISOString() : null,
    rejectionReason: r.rejectionReason,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// --------------------------- Custom models -------------------------------

export interface ImportCustomModelInput {
  name: string;
  filePath: string;
  displayName?: string;
  description?: string;
  architecture?: string;
  parameterCount?: string;
  quantization?: string;
  importedBy?: string;
  /** Skip the on-disk fingerprint — used by enterprise auto-installs. */
  skipFingerprint?: boolean;
  source?: string;
}

export async function importCustomModel(
  ctx: TenantContext,
  input: ImportCustomModelInput,
): Promise<CustomModelRow> {
  const name = validateName(input.name, "model name");
  const fingerprint = input.skipFingerprint
    ? { size: 0, sha256: "" }
    : await fingerprintFile(input.filePath, ["gguf"]);
  const id = `cm_${nanoid()}`;
  const now = Date.now();
  try {
    await db.insert(customModels).values(
      withTenantValues(ctx, {
        id,
        name,
        displayName: input.displayName ?? name,
        description: input.description ?? "",
        filePath: input.filePath,
        fileSize: fingerprint.size,
        format: "gguf",
        architecture: input.architecture ?? "",
        parameterCount: input.parameterCount ?? "",
        quantization: input.quantization ?? "",
        sha256: fingerprint.sha256,
        status: "active",
        source: input.source ?? "local",
        importedBy: input.importedBy ?? "",
        createdAt: now,
        updatedAt: now,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      throw new CustomModelError(
        "DUPLICATE_NAME",
        `a custom model named "${name}" already exists in this workspace`,
      );
    }
    throw e;
  }
  const fresh = await db
    .select()
    .from(customModels)
    .where(eq(customModels.id, id))
    .limit(1);
  return customModelToRow(fresh[0]!);
}

export async function listCustomModels(
  ctx: TenantContext,
): Promise<CustomModelRow[]> {
  const rows = await db
    .select()
    .from(customModels)
    .where(tenantScope(ctx, customModels));
  return rows.map(customModelToRow);
}

export async function setCustomModelStatus(
  ctx: TenantContext,
  id: string,
  status: ModelStatus,
): Promise<CustomModelRow> {
  const rows = await db
    .select()
    .from(customModels)
    .where(and(tenantScope(ctx, customModels), eq(customModels.id, id)))
    .limit(1);
  if (!rows[0]) {
    throw new CustomModelError("NOT_FOUND", `custom model "${id}" not found`);
  }
  await db
    .update(customModels)
    .set({ status, updatedAt: Date.now() })
    .where(eq(customModels.id, id));
  const fresh = await db
    .select()
    .from(customModels)
    .where(eq(customModels.id, id))
    .limit(1);
  return customModelToRow(fresh[0]!);
}

export async function deleteCustomModel(
  ctx: TenantContext,
  id: string,
): Promise<{ deleted: boolean }> {
  const rows = await db
    .select()
    .from(customModels)
    .where(and(tenantScope(ctx, customModels), eq(customModels.id, id)))
    .limit(1);
  if (!rows[0]) {
    throw new CustomModelError("NOT_FOUND", `custom model "${id}" not found`);
  }
  await db.delete(customModels).where(eq(customModels.id, id));
  return { deleted: true };
}

// --------------------------- LoRA adapters -------------------------------

export interface ImportLoraAdapterInput {
  name: string;
  filePath: string;
  baseModel: string;
  displayName?: string;
  description?: string;
  rank?: number;
  alpha?: number;
  importedBy?: string;
  skipFingerprint?: boolean;
  source?: string;
}

/**
 * Returns the list of base-model identifiers known to this tenant. A
 * "known" base model is either a custom-imported model or any non-empty
 * string the runtime might recognise — we accept both, but reject
 * empty / whitespace values so the UI surfaces a clear error rather
 * than silently registering an adapter with no anchor.
 */
async function knownBaseModelNames(ctx: TenantContext): Promise<Set<string>> {
  const rows = await db
    .select({ name: customModels.name })
    .from(customModels)
    .where(tenantScope(ctx, customModels));
  return new Set(rows.map((r) => r.name));
}

export async function importLoraAdapter(
  ctx: TenantContext,
  input: ImportLoraAdapterInput,
): Promise<LoraAdapterRow> {
  const name = validateName(input.name, "adapter name");
  const baseModel = input.baseModel.trim();
  if (baseModel.length === 0) {
    throw new CustomModelError(
      "INVALID_BASE_MODEL",
      "baseModel is required — a LoRA adapter must declare which base model it was trained against",
    );
  }
  const fingerprint = input.skipFingerprint
    ? { size: 0, sha256: "" }
    : await fingerprintFile(input.filePath, ["bin", "safetensors"]);
  const format = path.extname(input.filePath).toLowerCase().replace(/^\./, "") || "safetensors";
  const id = `lora_${nanoid()}`;
  const now = Date.now();
  try {
    await db.insert(loraAdapters).values(
      withTenantValues(ctx, {
        id,
        name,
        displayName: input.displayName ?? name,
        description: input.description ?? "",
        baseModel,
        filePath: input.filePath,
        fileSize: fingerprint.size,
        format,
        rank: input.rank ?? 0,
        alpha: input.alpha ?? 0,
        sha256: fingerprint.sha256,
        status: "active",
        source: input.source ?? "local",
        importedBy: input.importedBy ?? "",
        createdAt: now,
        updatedAt: now,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      throw new CustomModelError(
        "DUPLICATE_NAME",
        `a LoRA adapter named "${name}" already exists in this workspace`,
      );
    }
    throw e;
  }
  const fresh = await db
    .select()
    .from(loraAdapters)
    .where(eq(loraAdapters.id, id))
    .limit(1);
  return loraAdapterToRow(fresh[0]!);
}

export async function listLoraAdapters(
  ctx: TenantContext,
  baseModel?: string,
): Promise<LoraAdapterRow[]> {
  const where = baseModel
    ? and(tenantScope(ctx, loraAdapters), eq(loraAdapters.baseModel, baseModel))!
    : tenantScope(ctx, loraAdapters);
  const rows = await db.select().from(loraAdapters).where(where);
  return rows.map(loraAdapterToRow);
}

export async function setLoraAdapterStatus(
  ctx: TenantContext,
  id: string,
  status: ModelStatus,
): Promise<LoraAdapterRow> {
  const rows = await db
    .select()
    .from(loraAdapters)
    .where(and(tenantScope(ctx, loraAdapters), eq(loraAdapters.id, id)))
    .limit(1);
  if (!rows[0]) {
    throw new CustomModelError("NOT_FOUND", `LoRA adapter "${id}" not found`);
  }
  await db
    .update(loraAdapters)
    .set({ status, updatedAt: Date.now() })
    .where(eq(loraAdapters.id, id));
  const fresh = await db
    .select()
    .from(loraAdapters)
    .where(eq(loraAdapters.id, id))
    .limit(1);
  return loraAdapterToRow(fresh[0]!);
}

export async function deleteLoraAdapter(
  ctx: TenantContext,
  id: string,
): Promise<{ deleted: boolean }> {
  const rows = await db
    .select()
    .from(loraAdapters)
    .where(and(tenantScope(ctx, loraAdapters), eq(loraAdapters.id, id)))
    .limit(1);
  if (!rows[0]) {
    throw new CustomModelError("NOT_FOUND", `LoRA adapter "${id}" not found`);
  }
  await db.delete(loraAdapters).where(eq(loraAdapters.id, id));
  // Clear any workspace assignment that pointed at this adapter so the
  // runtime never tries to load an adapter that no longer exists.
  await db
    .update(workspaceAdapterAssignments)
    .set({ adapterId: "", updatedAt: Date.now() })
    .where(
      and(
        tenantScope(ctx, workspaceAdapterAssignments),
        eq(workspaceAdapterAssignments.adapterId, id),
      ),
    );
  return { deleted: true };
}

/**
 * Cross-check that an adapter's `baseModel` resolves to something this
 * tenant has installed (custom model) — used by the explicit
 * compatibility endpoint and by the assignment flow. Cloud / built-in
 * runtime models are always accepted because the runtime owns that
 * registry; this check guards the local-side mistake of pairing an
 * adapter with a typo'd or never-imported model name.
 */
export async function checkAdapterCompatibility(
  ctx: TenantContext,
  adapterId: string,
): Promise<{
  adapter: LoraAdapterRow;
  isLocallyKnown: boolean;
  knownBaseModels: string[];
}> {
  const rows = await db
    .select()
    .from(loraAdapters)
    .where(and(tenantScope(ctx, loraAdapters), eq(loraAdapters.id, adapterId)))
    .limit(1);
  if (!rows[0]) {
    throw new CustomModelError("NOT_FOUND", `LoRA adapter "${adapterId}" not found`);
  }
  const adapter = loraAdapterToRow(rows[0]);
  const known = await knownBaseModelNames(ctx);
  return {
    adapter,
    isLocallyKnown: known.has(adapter.baseModel),
    knownBaseModels: Array.from(known).sort(),
  };
}

// --------------------------- Workspace assignments -----------------------

export async function listWorkspaceAdapterAssignments(
  ctx: TenantContext,
): Promise<WorkspaceAdapterAssignmentRow[]> {
  const rows = await db
    .select()
    .from(workspaceAdapterAssignments)
    .where(tenantScope(ctx, workspaceAdapterAssignments));
  if (rows.length === 0) return [];
  // Resolve adapter names so the UI can render a friendly label.
  const adapterRows = await db
    .select()
    .from(loraAdapters)
    .where(tenantScope(ctx, loraAdapters));
  const byId = new Map(adapterRows.map((a) => [a.id, a]));
  return rows.map((r) => {
    const adapter = r.adapterId ? byId.get(r.adapterId) ?? null : null;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      baseModel: r.baseModel,
      adapterId: r.adapterId || null,
      adapterName: adapter ? adapter.name : null,
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  });
}

export async function setWorkspaceAdapterAssignment(
  ctx: TenantContext,
  baseModel: string,
  adapterId: string | null,
): Promise<WorkspaceAdapterAssignmentRow> {
  const trimmedBase = baseModel.trim();
  if (trimmedBase.length === 0) {
    throw new CustomModelError("INVALID_BASE_MODEL", "baseModel is required");
  }
  let resolvedAdapter: typeof loraAdapters.$inferSelect | null = null;
  if (adapterId) {
    const adapterRows = await db
      .select()
      .from(loraAdapters)
      .where(and(tenantScope(ctx, loraAdapters), eq(loraAdapters.id, adapterId)))
      .limit(1);
    if (!adapterRows[0]) {
      throw new CustomModelError("NOT_FOUND", `LoRA adapter "${adapterId}" not found`);
    }
    if (adapterRows[0].baseModel !== trimmedBase) {
      throw new CustomModelError(
        "ADAPTER_INCOMPATIBLE",
        `adapter "${adapterRows[0].name}" was trained against "${adapterRows[0].baseModel}", not "${trimmedBase}"`,
      );
    }
    resolvedAdapter = adapterRows[0];
  }
  const now = Date.now();
  const existing = await db
    .select()
    .from(workspaceAdapterAssignments)
    .where(
      and(
        tenantScope(ctx, workspaceAdapterAssignments),
        eq(workspaceAdapterAssignments.baseModel, trimmedBase),
      ),
    )
    .limit(1);
  let id: string;
  if (existing[0]) {
    id = existing[0].id;
    await db
      .update(workspaceAdapterAssignments)
      .set({ adapterId: adapterId ?? "", updatedAt: now })
      .where(eq(workspaceAdapterAssignments.id, id));
  } else {
    id = `wa_${nanoid()}`;
    await db.insert(workspaceAdapterAssignments).values(
      withTenantValues(ctx, {
        id,
        baseModel: trimmedBase,
        adapterId: adapterId ?? "",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  return {
    id,
    workspaceId: ctx.workspaceId ?? "",
    baseModel: trimmedBase,
    adapterId: adapterId ?? null,
    adapterName: resolvedAdapter ? resolvedAdapter.name : null,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * Resolve the active LoRA adapter (if any) for the current workspace +
 * base model. Used by the agent loop to inject the correct adapter into
 * the runtime call. Returns `null` when no adapter is bound or the
 * binding was explicitly cleared.
 */
export async function resolveActiveAdapterForBaseModel(
  ctx: TenantContext,
  baseModel: string,
): Promise<LoraAdapterRow | null> {
  const rows = await db
    .select()
    .from(workspaceAdapterAssignments)
    .where(
      and(
        tenantScope(ctx, workspaceAdapterAssignments),
        eq(workspaceAdapterAssignments.baseModel, baseModel),
      ),
    )
    .limit(1);
  const adapterId = rows[0]?.adapterId;
  if (!adapterId) return null;
  const adapterRows = await db
    .select()
    .from(loraAdapters)
    .where(and(tenantScope(ctx, loraAdapters), eq(loraAdapters.id, adapterId)))
    .limit(1);
  if (!adapterRows[0] || adapterRows[0].status !== "active") return null;
  return loraAdapterToRow(adapterRows[0]);
}

// --------------------------- Skill manifest preferences ------------------

export async function listSkillAdapterPreferences(
  ctx: TenantContext,
): Promise<SkillAdapterPreferenceRow[]> {
  const rows = await db
    .select()
    .from(skillAdapterPreferences)
    .where(tenantScope(ctx, skillAdapterPreferences));
  return rows.map((r) => ({
    id: r.id,
    skillSlug: r.skillSlug,
    baseModel: r.baseModel,
    adapterName: r.adapterName,
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
}

export async function setSkillAdapterPreference(
  ctx: TenantContext,
  input: { skillSlug: string; baseModel?: string; adapterName: string },
): Promise<SkillAdapterPreferenceRow> {
  const slug = input.skillSlug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new CustomModelError(
      "INVALID_SLUG",
      "skillSlug must be lowercase a-z, 0-9, or '-' (1-64 chars)",
    );
  }
  const adapterName = input.adapterName.trim();
  if (adapterName.length === 0) {
    throw new CustomModelError("INVALID_ADAPTER_NAME", "adapterName is required");
  }
  const baseModel = (input.baseModel ?? "").trim();
  const now = Date.now();
  const existing = await db
    .select()
    .from(skillAdapterPreferences)
    .where(
      and(
        tenantScope(ctx, skillAdapterPreferences),
        eq(skillAdapterPreferences.skillSlug, slug),
      ),
    )
    .limit(1);
  let id: string;
  if (existing[0]) {
    id = existing[0].id;
    await db
      .update(skillAdapterPreferences)
      .set({ adapterName, baseModel, updatedAt: now })
      .where(eq(skillAdapterPreferences.id, id));
  } else {
    id = `sap_${nanoid()}`;
    await db.insert(skillAdapterPreferences).values(
      withTenantValues(ctx, {
        id,
        skillSlug: slug,
        baseModel,
        adapterName,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  return { id, skillSlug: slug, baseModel, adapterName, updatedAt: new Date(now).toISOString() };
}

export async function deleteSkillAdapterPreference(
  ctx: TenantContext,
  skillSlug: string,
): Promise<{ deleted: boolean }> {
  const slug = skillSlug.trim().toLowerCase();
  await db
    .delete(skillAdapterPreferences)
    .where(
      and(
        tenantScope(ctx, skillAdapterPreferences),
        eq(skillAdapterPreferences.skillSlug, slug),
      ),
    );
  return { deleted: true };
}

/**
 * Resolve the active adapter a skill should use when it runs. Returns
 * the matching `LoraAdapter` row when:
 *   1. The skill has an `adapter_name` preference for the current
 *      workspace, AND
 *   2. An adapter with that name is installed and active.
 * Used by `skill-runtime` to wire the correct adapter into the runtime
 * call without the skill author having to write any glue code.
 */
export async function resolveAdapterForSkill(
  ctx: TenantContext,
  skillSlug: string,
): Promise<LoraAdapterRow | null> {
  const slug = skillSlug.trim().toLowerCase();
  const prefRows = await db
    .select()
    .from(skillAdapterPreferences)
    .where(
      and(
        tenantScope(ctx, skillAdapterPreferences),
        eq(skillAdapterPreferences.skillSlug, slug),
      ),
    )
    .limit(1);
  const pref = prefRows[0];
  if (!pref) return null;
  const adapterRows = await db
    .select()
    .from(loraAdapters)
    .where(and(tenantScope(ctx, loraAdapters), eq(loraAdapters.name, pref.adapterName)))
    .limit(1);
  if (!adapterRows[0] || adapterRows[0].status !== "active") return null;
  return loraAdapterToRow(adapterRows[0]);
}

// --------------------------- Enterprise distribution ---------------------

export interface RegisterEnterpriseAssetInput {
  kind: "model" | "adapter";
  name: string;
  displayName?: string;
  description?: string;
  baseModel?: string;
  sourcePath: string;
  fileSize?: number;
  sha256?: string;
}

export async function registerEnterpriseAsset(
  ctx: TenantContext,
  input: RegisterEnterpriseAssetInput,
): Promise<EnterpriseModelDistributionRow> {
  if (input.kind !== "model" && input.kind !== "adapter") {
    throw new CustomModelError("INVALID_KIND", "kind must be 'model' or 'adapter'");
  }
  const name = validateName(input.name, "asset name");
  if (input.kind === "adapter" && (!input.baseModel || input.baseModel.trim().length === 0)) {
    throw new CustomModelError(
      "INVALID_BASE_MODEL",
      "baseModel is required when kind is 'adapter'",
    );
  }
  const org = await getOrCreateOrg(ctx);
  const id = `emd_${nanoid()}`;
  const now = Date.now();
  try {
    await db.insert(enterpriseModelDistributions).values(
      withTenantValues(ctx, {
        id,
        orgId: org.id,
        kind: input.kind,
        name,
        displayName: input.displayName ?? name,
        description: input.description ?? "",
        baseModel: input.baseModel ?? "",
        sourcePath: input.sourcePath,
        fileSize: input.fileSize ?? 0,
        sha256: input.sha256 ?? "",
        status: "pending",
        approvedBy: "",
        approvedAt: null,
        rejectionReason: "",
        createdAt: now,
        updatedAt: now,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      throw new CustomModelError(
        "DUPLICATE_NAME",
        `an enterprise ${input.kind} named "${name}" is already registered`,
      );
    }
    throw e;
  }
  const fresh = await db
    .select()
    .from(enterpriseModelDistributions)
    .where(eq(enterpriseModelDistributions.id, id))
    .limit(1);
  return distributionToRow(fresh[0]!);
}

export async function listEnterpriseAssets(
  ctx: TenantContext,
  options: { status?: "pending" | "approved" | "rejected" | "all" } = {},
): Promise<EnterpriseModelDistributionRow[]> {
  const org = await getOrCreateOrg(ctx);
  const conditions = [
    tenantScope(ctx, enterpriseModelDistributions),
    eq(enterpriseModelDistributions.orgId, org.id),
  ];
  if (options.status && options.status !== "all") {
    conditions.push(eq(enterpriseModelDistributions.status, options.status));
  }
  const rows = await db
    .select()
    .from(enterpriseModelDistributions)
    .where(and(...conditions));
  return rows.map(distributionToRow);
}

export async function setEnterpriseAssetStatus(
  ctx: TenantContext,
  id: string,
  status: "approved" | "rejected",
  reviewer: string,
  reason = "",
): Promise<EnterpriseModelDistributionRow> {
  const rows = await db
    .select()
    .from(enterpriseModelDistributions)
    .where(
      and(
        tenantScope(ctx, enterpriseModelDistributions),
        eq(enterpriseModelDistributions.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new CustomModelError("NOT_FOUND", `enterprise asset "${id}" not found`);
  }
  const now = Date.now();
  await db
    .update(enterpriseModelDistributions)
    .set({
      status,
      approvedBy: status === "approved" ? reviewer : rows[0].approvedBy,
      approvedAt: status === "approved" ? now : rows[0].approvedAt,
      rejectionReason: status === "rejected" ? reason : "",
      updatedAt: now,
    })
    .where(eq(enterpriseModelDistributions.id, id));
  const fresh = await db
    .select()
    .from(enterpriseModelDistributions)
    .where(eq(enterpriseModelDistributions.id, id))
    .limit(1);
  return distributionToRow(fresh[0]!);
}

export async function deleteEnterpriseAsset(
  ctx: TenantContext,
  id: string,
): Promise<{ deleted: boolean }> {
  const rows = await db
    .select()
    .from(enterpriseModelDistributions)
    .where(
      and(
        tenantScope(ctx, enterpriseModelDistributions),
        eq(enterpriseModelDistributions.id, id),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new CustomModelError("NOT_FOUND", `enterprise asset "${id}" not found`);
  }
  await db
    .delete(enterpriseModelDistributions)
    .where(eq(enterpriseModelDistributions.id, id));
  return { deleted: true };
}
