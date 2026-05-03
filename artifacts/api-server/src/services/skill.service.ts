/**
 * Skills service — local Skills Marketplace.
 *
 * Skills are user-authored or community-imported instruction-sets tagged to
 * one or more local models. The Router agent (in agent.service.ts) consults
 * the installed skills list when picking a route — if a goal contains a
 * trigger word from an installed skill, that skill's `content` is injected
 * into the run as a system message so the planner can use it as guidance.
 *
 * Every read uses `tenantScope`; every write uses `withTenantValues`. Imports
 * and exports go through the canonical `.skill` JSON manifest format
 * (see `SKILL_MANIFEST_VERSION`).
 *
 * All install / uninstall / import operations write a `skill.*` row into
 * the privacy-events log so users can audit which skills ran on their data.
 */
import { and, desc, eq, like, lt, or } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  skills,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

export const SKILL_MANIFEST_VERSION = 1 as const;

export interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  modelTags: string[];
  triggers: string[];
  category: string;
  author: string;
  isInstalled: boolean;
  installCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillManifest {
  omninitySkillVersion: 1;
  slug: string;
  name: string;
  description: string;
  content: string;
  modelTags: string[];
  triggers: string[];
  category: string;
  author: string;
  version: number;
}

export interface CreateSkillInput {
  slug?: string;
  name: string;
  description?: string;
  content: string;
  modelTags?: string[];
  triggers?: string[];
  category?: string;
  author?: string;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  content?: string;
  modelTags?: string[];
  triggers?: string[];
  category?: string;
}

export class SkillNotFoundError extends Error {
  override readonly name = "SkillNotFoundError";
  readonly code = "SKILL_NOT_FOUND";
  constructor(id: string) {
    super(`Unknown skill "${id}"`);
  }
}

export class SkillValidationError extends Error {
  override readonly name = "SkillValidationError";
  readonly code = "SKILL_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

function parseStringArray(raw: string, field: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch (e) {
    logger.warn({ err: e, field }, "Failed to parse skill JSON column — defaulting to []");
    return [];
  }
}

function toRow(r: typeof skills.$inferSelect): SkillRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    content: r.content,
    modelTags: parseStringArray(r.modelTags, "modelTags"),
    triggers: parseStringArray(r.triggers, "triggers"),
    category: r.category,
    author: r.author,
    isInstalled: Boolean(r.isInstalled),
    installCount: r.installCount,
    version: r.version,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "skill";
}

async function findBySlug(
  ctx: TenantContext,
  slug: string,
): Promise<typeof skills.$inferSelect | null> {
  const rows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.slug, slug)))
    .limit(1);
  return rows[0] ?? null;
}

async function ensureUniqueSlug(
  ctx: TenantContext,
  base: string,
): Promise<string> {
  const baseSlug = slugify(base);
  let candidate = baseSlug;
  let suffix = 2;
  // Bound the loop so a misbehaving caller can't exhaust the request.
  while (suffix < 1000) {
    const existing = await findBySlug(ctx, candidate);
    if (!existing) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix++;
  }
  return `${baseSlug}-${nanoid(6)}`;
}

export interface ListSkillsOptions {
  cursor?: string;
  limit?: number;
  category?: string;
  installed?: boolean;
  search?: string;
}

export async function listSkills(
  ctx: TenantContext,
  opts: ListSkillsOptions = {},
): Promise<PaginatedData<SkillRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, skills);
  const filters: ReturnType<typeof and>[] = [];
  if (opts.category) filters.push(eq(skills.category, opts.category));
  if (typeof opts.installed === "boolean") {
    filters.push(eq(skills.isInstalled, opts.installed));
  }
  if (opts.search && opts.search.trim().length > 0) {
    const needle = `%${opts.search.trim().toLowerCase()}%`;
    const orClause = or(
      like(skills.name, needle),
      like(skills.slug, needle),
      like(skills.description, needle),
      like(skills.author, needle),
    );
    if (orClause) filters.push(orClause);
  }
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(skills.createdAt, cursorTs));
  }
  const where = filters.length > 0 ? and(baseScope, ...filters) : baseScope;

  const rows = await db
    .select()
    .from(skills)
    .where(where)
    .orderBy(desc(skills.installCount), desc(skills.createdAt))
    .limit(limit + 1);

  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getSkill(
  ctx: TenantContext,
  id: string,
): Promise<SkillRow | null> {
  const rows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createSkill(
  ctx: TenantContext,
  input: CreateSkillInput,
): Promise<SkillRow> {
  const id = `skill_${nanoid()}`;
  const slug = await ensureUniqueSlug(ctx, input.slug ?? input.name);
  const modelTags = (input.modelTags ?? []).filter((t) => typeof t === "string");
  const triggers = (input.triggers ?? []).filter((t) => typeof t === "string");
  await db.insert(skills).values(
    withTenantValues(ctx, {
      id,
      slug,
      name: input.name.trim(),
      description: (input.description ?? "").trim(),
      content: input.content,
      modelTags: JSON.stringify(modelTags),
      triggers: JSON.stringify(triggers),
      category: input.category ?? "Productivity",
      author: input.author ?? (ctx.userId ?? "local"),
      isInstalled: false,
      installCount: 0,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "skill.create",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `slug=${slug}`,
  });
  const row = await getSkill(ctx, id);
  if (!row) throw new Error("Skill vanished after creation");
  return row;
}

export async function updateSkill(
  ctx: TenantContext,
  id: string,
  input: UpdateSkillInput,
): Promise<SkillRow> {
  const existing = await getSkill(ctx, id);
  if (!existing) throw new SkillNotFoundError(id);
  const patch: Partial<typeof skills.$inferInsert> = {
    updatedAt: Date.now(),
    version: existing.version + 1,
  };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description.trim();
  if (input.content !== undefined) patch.content = input.content;
  if (input.modelTags !== undefined) patch.modelTags = JSON.stringify(input.modelTags);
  if (input.triggers !== undefined) patch.triggers = JSON.stringify(input.triggers);
  if (input.category !== undefined) patch.category = input.category;

  await db
    .update(skills)
    .set(patch)
    .where(and(tenantScope(ctx, skills), eq(skills.id, id), eq(skills.version, existing.version)));

  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

export async function deleteSkill(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getSkill(ctx, id);
  if (!existing) return { id, deleted: false };
  await db.delete(skills).where(and(tenantScope(ctx, skills), eq(skills.id, id)));
  await logPrivacyEvent(ctx, {
    eventType: "skill.delete",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `slug=${existing.slug}`,
  });
  return { id, deleted: true };
}

export async function installSkill(ctx: TenantContext, id: string): Promise<SkillRow> {
  const existing = await getSkill(ctx, id);
  if (!existing) throw new SkillNotFoundError(id);
  if (!existing.isInstalled) {
    await db
      .update(skills)
      .set({
        isInstalled: true,
        installCount: existing.installCount + 1,
        updatedAt: Date.now(),
        version: existing.version + 1,
      })
      .where(and(tenantScope(ctx, skills), eq(skills.id, id), eq(skills.version, existing.version)));
    await logPrivacyEvent(ctx, {
      eventType: "skill.install",
      actor: ctx.userId ?? ctx.tenantId,
      target: id,
      severity: "info",
      detail: `slug=${existing.slug}`,
    });
  }
  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

export async function uninstallSkill(ctx: TenantContext, id: string): Promise<SkillRow> {
  const existing = await getSkill(ctx, id);
  if (!existing) throw new SkillNotFoundError(id);
  if (existing.isInstalled) {
    await db
      .update(skills)
      .set({
        isInstalled: false,
        updatedAt: Date.now(),
        version: existing.version + 1,
      })
      .where(and(tenantScope(ctx, skills), eq(skills.id, id), eq(skills.version, existing.version)));
    await logPrivacyEvent(ctx, {
      eventType: "skill.uninstall",
      actor: ctx.userId ?? ctx.tenantId,
      target: id,
      severity: "info",
      detail: `slug=${existing.slug}`,
    });
  }
  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

export async function exportSkill(
  ctx: TenantContext,
  id: string,
): Promise<SkillManifest> {
  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  await logPrivacyEvent(ctx, {
    eventType: "skill.export",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `slug=${row.slug}`,
  });
  return {
    omninitySkillVersion: SKILL_MANIFEST_VERSION,
    slug: row.slug,
    name: row.name,
    description: row.description,
    content: row.content,
    modelTags: row.modelTags,
    triggers: row.triggers,
    category: row.category,
    author: row.author,
    version: row.version,
  };
}

export async function importSkill(
  ctx: TenantContext,
  manifest: SkillManifest,
  options: { install?: boolean } = {},
): Promise<SkillRow> {
  if (manifest.omninitySkillVersion !== SKILL_MANIFEST_VERSION) {
    throw new SkillValidationError(
      `Unsupported skill manifest version: ${manifest.omninitySkillVersion}`,
    );
  }
  if (!manifest.name || !manifest.content) {
    throw new SkillValidationError("Manifest is missing required fields name/content");
  }
  const created = await createSkill(ctx, {
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description,
    content: manifest.content,
    modelTags: manifest.modelTags ?? [],
    triggers: manifest.triggers ?? [],
    category: manifest.category,
    author: manifest.author,
  });
  await logPrivacyEvent(ctx, {
    eventType: "skill.import",
    actor: ctx.userId ?? ctx.tenantId,
    target: created.id,
    severity: "info",
    detail: `slug=${created.slug} install=${Boolean(options.install)}`,
  });
  if (options.install) {
    return installSkill(ctx, created.id);
  }
  return created;
}

/**
 * Find an installed skill whose triggers match the given goal text.
 * Used by the Router agent to decide whether a skill should be injected
 * into a run. Returns the highest-installCount match (most popular wins).
 */
export async function matchSkillForGoal(
  ctx: TenantContext,
  goal: string,
): Promise<SkillRow | null> {
  const lower = goal.toLowerCase();
  const rows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.isInstalled, true)))
    .orderBy(desc(skills.installCount));

  for (const r of rows) {
    const triggers = parseStringArray(r.triggers, "triggers");
    if (triggers.length === 0) continue;
    const hit = triggers.some((t) => {
      const needle = t.toLowerCase().trim();
      return needle.length > 0 && lower.includes(needle);
    });
    if (hit) return toRow(r);
  }
  return null;
}
