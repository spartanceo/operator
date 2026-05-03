/**
 * Task Templates service — Task #46.
 *
 * A template captures everything needed to re-run a task: a prompt that
 * may contain `{{variable}}` tokens, a JSON declaration of those
 * variables, a snapshot of the agent/skill configuration the task ran
 * with, and quick-launch / category metadata.
 *
 * The "max 5 pinned templates per workspace" rule is enforced here in
 * the service, not at the DB layer, because the cap is a UX decision
 * and may grow without a schema change.
 *
 * Categories are workspace-scoped folders. Both tables use `tenantScope`
 * for reads and `withTenantValues` for writes, exactly like every other
 * workspace-scoped resource.
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  taskTemplateCategories,
  taskTemplates,
  tenantScope,
  withTenantValues,
  type PaginatedData,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TemplateVariable {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
}

export interface TemplateSkillConfig {
  agentMode?: boolean;
  model?: string;
  conversationId?: string | null;
  [key: string]: unknown;
}

export interface TaskTemplateRow {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  variables: TemplateVariable[];
  skillConfig: TemplateSkillConfig;
  categoryId: string | null;
  pinnedOrder: number | null;
  usageCount: number;
  lastUsedAt: string | null;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTemplateCategoryRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateInput {
  name: string;
  description?: string | null;
  prompt: string;
  variables?: TemplateVariable[];
  skillConfig?: TemplateSkillConfig;
  categoryId?: string | null;
  sourceRunId?: string | null;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string | null;
  prompt?: string;
  variables?: TemplateVariable[];
  skillConfig?: TemplateSkillConfig;
  categoryId?: string | null;
}

export interface RunTemplateResult {
  template: TaskTemplateRow;
  resolvedPrompt: string;
}

export interface TemplateExport {
  schemaVersion: 1;
  exportedAt: string;
  template: {
    name: string;
    description: string | null;
    prompt: string;
    variables: TemplateVariable[];
    skillConfig: TemplateSkillConfig;
    category: { name: string; color: string | null; icon: string | null } | null;
  };
}

export class TemplateConflictError extends Error {
  override readonly name = "TemplateConflictError";
  constructor(
    public readonly code:
      | "PIN_LIMIT_REACHED"
      | "MISSING_VARIABLE"
      | "INVALID_TEMPLATE"
      | "INVALID_NAME"
      | "CATEGORY_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

// tier-review: bounded — fixed UX cap. Service refuses to pin past this.
export const MAX_PINNED_PER_WORKSPACE = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function normaliseVariables(input: unknown): TemplateVariable[] {
  if (!Array.isArray(input)) return [];
  const out: TemplateVariable[] = [];
  // tier-review: bounded — capped at 32 declared variables per template.
  for (const raw of input.slice(0, 32)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = String(r["name"] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name)) continue;
    const label = String(r["label"] ?? name).slice(0, 120);
    const item: TemplateVariable = { name, label };
    if (typeof r["defaultValue"] === "string") {
      item.defaultValue = (r["defaultValue"] as string).slice(0, 2000);
    }
    if (r["required"] === true) item.required = true;
    out.push(item);
  }
  return out;
}

function normaliseSkillConfig(input: unknown): TemplateSkillConfig {
  if (!input || typeof input !== "object") return {};
  const r = input as Record<string, unknown>;
  const out: TemplateSkillConfig = {};
  if (typeof r["agentMode"] === "boolean") out.agentMode = r["agentMode"];
  if (typeof r["model"] === "string") out.model = (r["model"] as string).slice(0, 200);
  if (r["conversationId"] === null || typeof r["conversationId"] === "string") {
    out.conversationId = (r["conversationId"] as string | null) ?? null;
  }
  return out;
}

function toRow(r: typeof taskTemplates.$inferSelect): TaskTemplateRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    prompt: r.prompt,
    variables: safeParseJson<TemplateVariable[]>(r.variables, []),
    skillConfig: safeParseJson<TemplateSkillConfig>(r.skillConfig, {}),
    categoryId: r.categoryId,
    pinnedOrder: r.pinnedOrder,
    usageCount: r.usageCount,
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    sourceRunId: r.sourceRunId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toCategoryRow(
  r: typeof taskTemplateCategories.$inferSelect,
): TaskTemplateCategoryRow {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/**
 * Substitute `{{varName}}` tokens with caller-supplied values. Missing
 * required variables raise `TemplateConflictError("MISSING_VARIABLE")`.
 * Unknown tokens are left intact so prompts that legitimately use
 * `{{ }}` for non-variable purposes are not corrupted.
 */
export function fillTemplate(
  template: Pick<TaskTemplateRow, "prompt" | "variables">,
  values: Record<string, string>,
): string {
  for (const v of template.variables) {
    if (v.required && !values[v.name] && !v.defaultValue) {
      throw new TemplateConflictError(
        "MISSING_VARIABLE",
        `Missing required variable "${v.name}"`,
      );
    }
  }
  return template.prompt.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,40})\s*\}\}/g, (match, name: string) => {
    const v = template.variables.find((x) => x.name === name);
    if (values[name] !== undefined) return values[name] ?? "";
    if (v?.defaultValue !== undefined) return v.defaultValue;
    return match;
  });
}

// ─── Categories ────────────────────────────────────────────────────────────

export async function listCategories(
  ctx: TenantContext,
): Promise<TaskTemplateCategoryRow[]> {
  const rows = await db
    .select()
    .from(taskTemplateCategories)
    .where(tenantScope(ctx, taskTemplateCategories))
    .orderBy(taskTemplateCategories.name);
  return rows.map(toCategoryRow);
}

export async function createCategory(
  ctx: TenantContext,
  input: { name: string; color?: string | null; icon?: string | null },
): Promise<TaskTemplateCategoryRow> {
  const name = input.name.trim();
  if (!name) {
    throw new TemplateConflictError("INVALID_NAME", "Category name is required");
  }
  const id = `tcat_${nanoid()}`;
  await db.insert(taskTemplateCategories).values(
    withTenantValues(ctx, {
      id,
      name: name.slice(0, 80),
      color: input.color?.toString().slice(0, 40) ?? null,
      icon: input.icon?.toString().slice(0, 40) ?? null,
    }),
  );
  const created = await db
    .select()
    .from(taskTemplateCategories)
    .where(
      and(
        tenantScope(ctx, taskTemplateCategories),
        eq(taskTemplateCategories.id, id),
      ),
    )
    .limit(1);
  if (!created[0]) throw new Error("Category vanished after insert");
  return toCategoryRow(created[0]);
}

export async function deleteCategory(
  ctx: TenantContext,
  id: string,
): Promise<{ deleted: boolean }> {
  // Detach templates first so the FK doesn't trip.
  await db
    .update(taskTemplates)
    .set({ categoryId: null, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, taskTemplates), eq(taskTemplates.categoryId, id)));
  const res = await db
    .delete(taskTemplateCategories)
    .where(
      and(
        tenantScope(ctx, taskTemplateCategories),
        eq(taskTemplateCategories.id, id),
      ),
    );
  // better-sqlite3 returns { changes: number }; drizzle exposes it via rowsAffected on some adapters.
  const changes =
    (res as unknown as { changes?: number }).changes ??
    (res as unknown as { rowsAffected?: number }).rowsAffected ??
    0;
  return { deleted: changes > 0 };
}

// ─── Templates ─────────────────────────────────────────────────────────────

async function assertCategoryExists(
  ctx: TenantContext,
  categoryId: string,
): Promise<void> {
  const rows = await db
    .select({ id: taskTemplateCategories.id })
    .from(taskTemplateCategories)
    .where(
      and(
        tenantScope(ctx, taskTemplateCategories),
        eq(taskTemplateCategories.id, categoryId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new TemplateConflictError(
      "CATEGORY_NOT_FOUND",
      "Category does not exist in this workspace",
    );
  }
}

export async function listTemplates(
  ctx: TenantContext,
  params: {
    cursor?: string;
    limit?: number;
    categoryId?: string;
    pinnedOnly?: boolean;
    q?: string;
  } = {},
): Promise<PaginatedData<TaskTemplateRow>> {
  const limit = normaliseLimit(params.limit);
  const after = params.cursor ? decodeCursor(params.cursor) : null;
  const conds = [tenantScope(ctx, taskTemplates)];
  if (params.categoryId) conds.push(eq(taskTemplates.categoryId, params.categoryId));
  if (params.pinnedOnly === true) conds.push(isNotNull(taskTemplates.pinnedOrder));
  if (params.q) {
    const like = `%${params.q.toLowerCase()}%`;
    conds.push(
      sql`(LOWER(${taskTemplates.name}) LIKE ${like} OR LOWER(${taskTemplates.prompt}) LIKE ${like})`,
    );
  }
  if (after) {
    conds.push(sql`${taskTemplates.id} < ${after}`);
  }

  const rows = await db
    .select()
    .from(taskTemplates)
    .where(and(...conds))
    .orderBy(desc(taskTemplates.id))
    .limit(limit + 1);

  const page = buildPage(rows, limit, (r) => r.id);
  return { items: page.items.map(toRow), nextCursor: page.nextCursor };
}

export async function listPinnedTemplates(
  ctx: TenantContext,
): Promise<TaskTemplateRow[]> {
  const rows = await db
    .select()
    .from(taskTemplates)
    .where(
      and(tenantScope(ctx, taskTemplates), isNotNull(taskTemplates.pinnedOrder)),
    )
    .orderBy(taskTemplates.pinnedOrder)
    .limit(MAX_PINNED_PER_WORKSPACE);
  return rows.map(toRow);
}

export async function getTemplate(
  ctx: TenantContext,
  id: string,
): Promise<TaskTemplateRow | null> {
  const rows = await db
    .select()
    .from(taskTemplates)
    .where(and(tenantScope(ctx, taskTemplates), eq(taskTemplates.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createTemplate(
  ctx: TenantContext,
  input: CreateTemplateInput,
): Promise<TaskTemplateRow> {
  const name = input.name.trim();
  if (!name) {
    throw new TemplateConflictError("INVALID_NAME", "Template name is required");
  }
  if (!input.prompt || typeof input.prompt !== "string") {
    throw new TemplateConflictError(
      "INVALID_TEMPLATE",
      "Template prompt is required",
    );
  }
  if (input.categoryId) {
    await assertCategoryExists(ctx, input.categoryId);
  }
  const id = `tpl_${nanoid()}`;
  await db.insert(taskTemplates).values(
    withTenantValues(ctx, {
      id,
      name: name.slice(0, 120),
      description: input.description?.toString().slice(0, 1000) ?? null,
      prompt: input.prompt.slice(0, 20_000),
      variables: JSON.stringify(normaliseVariables(input.variables ?? [])),
      skillConfig: JSON.stringify(normaliseSkillConfig(input.skillConfig ?? {})),
      categoryId: input.categoryId ?? null,
      sourceRunId: input.sourceRunId ?? null,
    }),
  );
  const created = await getTemplate(ctx, id);
  if (!created) throw new Error("Template vanished after insert");
  return created;
}

export async function updateTemplate(
  ctx: TenantContext,
  id: string,
  input: UpdateTemplateInput,
): Promise<TaskTemplateRow | null> {
  const existing = await getTemplate(ctx, id);
  if (!existing) return null;
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new TemplateConflictError("INVALID_NAME", "Template name cannot be empty");
    }
    patch["name"] = trimmed.slice(0, 120);
  }
  if (input.description !== undefined) {
    patch["description"] = input.description?.toString().slice(0, 1000) ?? null;
  }
  if (input.prompt !== undefined) {
    patch["prompt"] = input.prompt.slice(0, 20_000);
  }
  if (input.variables !== undefined) {
    patch["variables"] = JSON.stringify(normaliseVariables(input.variables));
  }
  if (input.skillConfig !== undefined) {
    patch["skillConfig"] = JSON.stringify(normaliseSkillConfig(input.skillConfig));
  }
  if (input.categoryId !== undefined) {
    if (input.categoryId) await assertCategoryExists(ctx, input.categoryId);
    patch["categoryId"] = input.categoryId;
  }
  await db
    .update(taskTemplates)
    .set(patch)
    .where(and(tenantScope(ctx, taskTemplates), eq(taskTemplates.id, id)));
  return getTemplate(ctx, id);
}

export async function deleteTemplate(
  ctx: TenantContext,
  id: string,
): Promise<{ deleted: boolean }> {
  const existing = await getTemplate(ctx, id);
  if (!existing) return { deleted: false };
  await db
    .delete(taskTemplates)
    .where(and(tenantScope(ctx, taskTemplates), eq(taskTemplates.id, id)));
  return { deleted: true };
}

export async function setPinned(
  ctx: TenantContext,
  id: string,
  pinned: boolean,
): Promise<TaskTemplateRow | null> {
  const existing = await getTemplate(ctx, id);
  if (!existing) return null;
  if (pinned) {
    if (existing.pinnedOrder !== null) return existing;
    const pinnedNow = await listPinnedTemplates(ctx);
    if (pinnedNow.length >= MAX_PINNED_PER_WORKSPACE) {
      throw new TemplateConflictError(
        "PIN_LIMIT_REACHED",
        `Only ${MAX_PINNED_PER_WORKSPACE} templates can be pinned at once`,
      );
    }
    const nextOrder = (pinnedNow[pinnedNow.length - 1]?.pinnedOrder ?? 0) + 1;
    await db
      .update(taskTemplates)
      .set({ pinnedOrder: nextOrder, updatedAt: Date.now() })
      .where(and(tenantScope(ctx, taskTemplates), eq(taskTemplates.id, id)));
  } else {
    await db
      .update(taskTemplates)
      .set({ pinnedOrder: null, updatedAt: Date.now() })
      .where(and(tenantScope(ctx, taskTemplates), eq(taskTemplates.id, id)));
  }
  return getTemplate(ctx, id);
}

/**
 * Resolve `{{vars}}` and bump usage stats. Returns the substituted
 * prompt for the caller to feed into chat / agent. Does NOT itself
 * dispatch the run — that stays a UI concern so the existing chat or
 * agent flow can take over with one less moving part.
 */
export async function runTemplate(
  ctx: TenantContext,
  id: string,
  values: Record<string, string> = {},
): Promise<RunTemplateResult | null> {
  const template = await getTemplate(ctx, id);
  if (!template) return null;
  const resolved = fillTemplate(template, values);
  await db
    .update(taskTemplates)
    .set({
      usageCount: sql`${taskTemplates.usageCount} + 1`,
      lastUsedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(and(tenantScope(ctx, taskTemplates), eq(taskTemplates.id, id)));
  const reloaded = await getTemplate(ctx, id);
  return {
    template: reloaded ?? template,
    resolvedPrompt: resolved,
  };
}

// ─── Export / Import ───────────────────────────────────────────────────────

export async function exportTemplate(
  ctx: TenantContext,
  id: string,
): Promise<TemplateExport | null> {
  const template = await getTemplate(ctx, id);
  if (!template) return null;
  let category: TemplateExport["template"]["category"] = null;
  if (template.categoryId) {
    const rows = await db
      .select()
      .from(taskTemplateCategories)
      .where(
        and(
          tenantScope(ctx, taskTemplateCategories),
          eq(taskTemplateCategories.id, template.categoryId),
        ),
      )
      .limit(1);
    if (rows[0]) {
      category = { name: rows[0].name, color: rows[0].color, icon: rows[0].icon };
    }
  }
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    template: {
      name: template.name,
      description: template.description,
      prompt: template.prompt,
      variables: template.variables,
      skillConfig: template.skillConfig,
      category,
    },
  };
}

export async function importTemplate(
  ctx: TenantContext,
  payload: unknown,
  override: { name?: string } = {},
): Promise<TaskTemplateRow> {
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { schemaVersion?: number }).schemaVersion !== 1 ||
    typeof (payload as { template?: unknown }).template !== "object"
  ) {
    throw new TemplateConflictError(
      "INVALID_TEMPLATE",
      "Template payload does not match schemaVersion 1",
    );
  }
  const t = (payload as TemplateExport).template;
  if (!t || typeof t.prompt !== "string" || typeof t.name !== "string") {
    throw new TemplateConflictError(
      "INVALID_TEMPLATE",
      "Template payload is missing required fields",
    );
  }

  // Resolve / create the category by name if the export carried one.
  let categoryId: string | null = null;
  if (t.category && typeof t.category.name === "string") {
    const existing = await listCategories(ctx);
    const match = existing.find(
      (c) => c.name.toLowerCase() === t.category!.name.toLowerCase(),
    );
    if (match) {
      categoryId = match.id;
    } else {
      const created = await createCategory(ctx, {
        name: t.category.name,
        color: t.category.color,
        icon: t.category.icon,
      });
      categoryId = created.id;
    }
  }

  return createTemplate(ctx, {
    name: override.name?.trim() || t.name,
    description: t.description ?? null,
    prompt: t.prompt,
    variables: normaliseVariables(t.variables),
    skillConfig: normaliseSkillConfig(t.skillConfig),
    categoryId,
  });
}
