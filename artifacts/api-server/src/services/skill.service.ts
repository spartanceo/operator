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
  skillVersions,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { emitOpEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";
import { recordSkillUsage } from "./skill-reviews.service";

export const SKILL_MANIFEST_VERSION = 1 as const;

/**
 * Skills with no publish activity within this window are flagged as
 * "Unmaintained" in the marketplace UI. 12 months matches the wording
 * in the task spec.
 */
export const UNMAINTAINED_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;

/** OP version this server reports — used as the comparator for `min_op_version`. */
export function getOpVersion(): string {
  return process.env["npm_package_version"] ?? "0.0.0";
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(input: string): ParsedSemver | null {
  const m = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Returns >0 when a > b, <0 when a < b, 0 when equal. Non-semver compares as 0. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * Pack a semver into a single sortable integer (major*1e10 + minor*1e5 + patch).
 * 5 digits per component is plenty for the marketplace.
 */
function semverSortKey(version: string): number {
  const p = parseSemver(version);
  if (!p) return 0;
  return p.major * 10_000_000_000 + p.minor * 100_000 + p.patch;
}

/**
 * Validate that `next` is a strictly-greater semver than `prev`. Returns
 * an error message when invalid, null when accepted.
 */
export function validateVersionBump(prev: string, next: string): string | null {
  if (!parseSemver(next)) return "version must be a semantic version like 1.2.3";
  const cmp = compareSemver(next, prev);
  if (cmp <= 0) return `version must be greater than the current ${prev}`;
  return null;
}

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
  usageCount: number;
  ratingAvg: number;
  ratingCount: number;
  editorialPick: boolean;
  verifiedByOp: boolean;
  version: number;
  latestVersion: string;
  installedVersion: string;
  changelog: string;
  breakingChange: boolean;
  minOpVersion: string;
  autoUpdate: boolean;
  publishedAt: string;
  /** True iff `latestVersion > installedVersion` and not dismissed. */
  hasUpdate: boolean;
  /** True iff `latestVersion` requires an OP version newer than this server. */
  opIncompatible: boolean;
  /** True iff `publishedAt` is older than the unmaintained threshold. */
  unmaintained: boolean;
  /** Premium skills require a subscription past their preview allowance. */
  isPremium: boolean;
  /** Free invocations granted before the paywall kicks in (default 2). */
  previewUsesAllowed: number;
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
  semver?: string;
  changelog?: string;
  breakingChange?: boolean;
  minOpVersion?: string;
}

export interface SkillVersionRow {
  id: string;
  skillId: string;
  semver: string;
  changelog: string;
  breakingChange: boolean;
  minOpVersion: string;
  name: string;
  description: string;
  content: string;
  modelTags: string[];
  triggers: string[];
  category: string;
  author: string;
  installCount: number;
  createdAt: string;
}

export interface PublishVersionInput {
  version: string;
  changelog: string;
  breakingChange?: boolean;
  minOpVersion?: string;
  name?: string;
  description?: string;
  content?: string;
  modelTags?: string[];
  triggers?: string[];
  category?: string;
}

export interface VersionAdoption {
  semver: string;
  installCount: number;
  isLatest: boolean;
  isInstalled: boolean;
  /** Share of total installs across all versions, in [0, 1]. */
  share: number;
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
  /** Defaults to "1.0.0" when omitted. */
  initialVersion?: string;
  initialChangelog?: string;
  minOpVersion?: string;
  isPremium?: boolean;
  previewUsesAllowed?: number;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  content?: string;
  modelTags?: string[];
  triggers?: string[];
  category?: string;
  isPremium?: boolean;
  previewUsesAllowed?: number;
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
  const latestVersion = r.latestVersion || "1.0.0";
  const installedVersion = r.installedVersion || "1.0.0";
  const dismissed = r.updateDismissedVersion ?? null;
  const hasUpdate =
    compareSemver(latestVersion, installedVersion) > 0 &&
    (dismissed === null || compareSemver(latestVersion, dismissed) > 0);
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
    usageCount: r.usageCount,
    ratingAvg: r.ratingAvg,
    ratingCount: r.ratingCount,
    editorialPick: Boolean(r.editorialPick),
    verifiedByOp: Boolean(r.verifiedByOp),
    version: r.version,
    latestVersion,
    installedVersion,
    changelog: r.changelog ?? "",
    breakingChange: Boolean(r.breakingChange),
    minOpVersion: r.minOpVersion || "0.0.0",
    autoUpdate: Boolean(r.autoUpdate),
    publishedAt: new Date(r.publishedAt).toISOString(),
    hasUpdate,
    opIncompatible: compareSemver(r.minOpVersion || "0.0.0", getOpVersion()) > 0,
    unmaintained: Date.now() - r.publishedAt > UNMAINTAINED_THRESHOLD_MS,
    isPremium: Boolean(r.isPremium),
    previewUsesAllowed: r.previewUsesAllowed ?? 2,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toVersionRow(r: typeof skillVersions.$inferSelect): SkillVersionRow {
  return {
    id: r.id,
    skillId: r.skillId,
    semver: r.semver,
    changelog: r.changelog,
    breakingChange: Boolean(r.breakingChange),
    minOpVersion: r.minOpVersion,
    name: r.name,
    description: r.description,
    content: r.content,
    modelTags: parseStringArray(r.modelTags, "modelTags"),
    triggers: parseStringArray(r.triggers, "triggers"),
    category: r.category,
    author: r.author,
    installCount: r.installCount,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Persist a `skill_versions` row that snapshots the given skill at the
 * given semver. Idempotent on (tenant, skill, semver) thanks to the
 * unique index — duplicate publishes return the existing row.
 */
async function recordVersionSnapshot(
  ctx: TenantContext,
  skill: typeof skills.$inferSelect,
  opts: {
    semver: string;
    changelog: string;
    breakingChange: boolean;
    minOpVersion: string;
  },
): Promise<void> {
  await db
    .insert(skillVersions)
    .values(
      withTenantValues(ctx, {
        id: `skv_${nanoid()}`,
        skillId: skill.id,
        semver: opts.semver,
        sortKey: semverSortKey(opts.semver),
        changelog: opts.changelog,
        breakingChange: opts.breakingChange,
        minOpVersion: opts.minOpVersion,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        modelTags: skill.modelTags,
        triggers: skill.triggers,
        category: skill.category,
        author: skill.author,
        installCount: 0,
      }),
    )
    .onConflictDoNothing();
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

export type SkillSort =
  | "popular"
  | "highest-rated"
  | "most-used"
  | "newest"
  | "recently-updated";

export interface ListSkillsOptions {
  cursor?: string;
  limit?: number;
  category?: string;
  installed?: boolean;
  search?: string;
  sort?: SkillSort;
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

  const sort: SkillSort = opts.sort ?? "popular";
  const orderBy = (() => {
    switch (sort) {
      case "highest-rated":
        return [desc(skills.ratingAvg), desc(skills.ratingCount), desc(skills.createdAt)];
      case "most-used":
        return [desc(skills.usageCount), desc(skills.installCount), desc(skills.createdAt)];
      case "newest":
        return [desc(skills.createdAt)];
      case "recently-updated":
        return [desc(skills.updatedAt)];
      case "popular":
      default:
        return [desc(skills.installCount), desc(skills.createdAt)];
    }
  })();

  const rows = await db
    .select()
    .from(skills)
    .where(where)
    .orderBy(...orderBy)
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
  const initialSemver = input.initialVersion && parseSemver(input.initialVersion)
    ? input.initialVersion
    : "1.0.0";
  const initialChangelog = input.initialChangelog ?? "";
  const initialMinOpVersion =
    input.minOpVersion && parseSemver(input.minOpVersion)
      ? input.minOpVersion
      : "0.0.0";
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
      latestVersion: initialSemver,
      installedVersion: initialSemver,
      changelog: initialChangelog,
      breakingChange: false,
      minOpVersion: initialMinOpVersion,
      autoUpdate: false,
      publishedAt: Date.now(),
      isPremium: input.isPremium ?? false,
      previewUsesAllowed:
        typeof input.previewUsesAllowed === "number"
          ? Math.max(0, Math.floor(input.previewUsesAllowed))
          : 2,
    }),
  );
  // Seed the version-history snapshot — the row above is the canonical
  // source of truth for "current", but the marketplace UI lists every
  // version from skill_versions.
  const inserted = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.id, id)))
    .limit(1);
  if (inserted[0]) {
    await recordVersionSnapshot(ctx, inserted[0], {
      semver: initialSemver,
      changelog: initialChangelog,
      breakingChange: false,
      minOpVersion: initialMinOpVersion,
    });
  }
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
  if (input.isPremium !== undefined) patch.isPremium = input.isPremium;
  if (input.previewUsesAllowed !== undefined) {
    patch.previewUsesAllowed = Math.max(0, Math.floor(input.previewUsesAllowed));
  }

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
  if (existing.opIncompatible) {
    throw new SkillValidationError(
      `Skill requires OP ${existing.minOpVersion} but this server runs ${getOpVersion()}`,
    );
  }
  if (!existing.isInstalled) {
    await db
      .update(skills)
      .set({
        isInstalled: true,
        installCount: existing.installCount + 1,
        installedVersion: existing.latestVersion,
        updatedAt: Date.now(),
        version: existing.version + 1,
      })
      .where(and(tenantScope(ctx, skills), eq(skills.id, id), eq(skills.version, existing.version)));
    await bumpVersionAdoption(ctx, id, existing.latestVersion);
    await logPrivacyEvent(ctx, {
      eventType: "skill.install",
      actor: ctx.userId ?? ctx.tenantId,
      target: id,
      severity: "info",
      detail: `slug=${existing.slug} version=${existing.latestVersion}`,
    });
    // Install counts as the first verified usage — Task #33 verified-usage gate.
    try {
      await recordSkillUsage(ctx, id);
    } catch (e) {
      logger.warn({ err: e, skillId: id }, "Failed to record install usage event");
    }
    emitOpEvent(ctx, "skill_installed", { id, slug: existing.slug });
  }
  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

async function bumpVersionAdoption(
  ctx: TenantContext,
  skillId: string,
  semver: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        tenantScope(ctx, skillVersions),
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.semver, semver),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return;
  await db
    .update(skillVersions)
    .set({
      installCount: existing.installCount + 1,
      updatedAt: Date.now(),
      version: existing.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, skillVersions),
        eq(skillVersions.id, existing.id),
        eq(skillVersions.version, existing.version),
      ),
    );
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
    emitOpEvent(ctx, "skill_uninstalled", { id, slug: existing.slug });
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
    semver: row.latestVersion,
    changelog: row.changelog,
    breakingChange: row.breakingChange,
    minOpVersion: row.minOpVersion,
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
  const importedSemver =
    manifest.semver && parseSemver(manifest.semver) ? manifest.semver : "1.0.0";
  const importedMinOp =
    manifest.minOpVersion && parseSemver(manifest.minOpVersion)
      ? manifest.minOpVersion
      : "0.0.0";
  const created = await createSkill(ctx, {
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description,
    content: manifest.content,
    modelTags: manifest.modelTags ?? [],
    triggers: manifest.triggers ?? [],
    category: manifest.category,
    author: manifest.author,
    initialVersion: importedSemver,
    initialChangelog: manifest.changelog ?? "",
    minOpVersion: importedMinOp,
  });
  await logPrivacyEvent(ctx, {
    eventType: "skill.import",
    actor: ctx.userId ?? ctx.tenantId,
    target: created.id,
    severity: "info",
    detail: `slug=${created.slug} install=${Boolean(options.install)} version=${importedSemver}`,
  });
  if (options.install) {
    return installSkill(ctx, created.id);
  }
  return created;
}

// ─── Versioning & update management ──────────────────────────────────────────

/**
 * Publish a new version of a skill. Validates the semver, snapshots the
 * old current version into history, then atomically rolls the live
 * `skills` row forward — content/model-tags/etc are taken from the
 * publish payload (or carried over if omitted).
 *
 * Auto-update behaviour: when `autoUpdate` is on AND the change is
 * non-breaking, the installed version moves with the latest version.
 * Otherwise the installed version stays put and the user sees an
 * update card.
 */
export async function publishSkillVersion(
  ctx: TenantContext,
  id: string,
  input: PublishVersionInput,
): Promise<SkillRow> {
  const rows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.id, id)))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new SkillNotFoundError(id);

  const bumpError = validateVersionBump(existing.latestVersion, input.version);
  if (bumpError) throw new SkillValidationError(bumpError);
  if (input.minOpVersion && !parseSemver(input.minOpVersion)) {
    throw new SkillValidationError("minOpVersion must be a semantic version");
  }
  if (!input.changelog || input.changelog.trim().length === 0) {
    throw new SkillValidationError("Changelog is required when publishing a version");
  }

  const breakingChange = Boolean(input.breakingChange);
  const minOp = input.minOpVersion ?? existing.minOpVersion ?? "0.0.0";
  const nextName = input.name?.trim() ?? existing.name;
  const nextDescription = input.description?.trim() ?? existing.description;
  const nextContent = input.content ?? existing.content;
  const nextModelTags =
    input.modelTags !== undefined
      ? JSON.stringify(input.modelTags)
      : existing.modelTags;
  const nextTriggers =
    input.triggers !== undefined
      ? JSON.stringify(input.triggers)
      : existing.triggers;
  const nextCategory = input.category ?? existing.category;

  const installedShouldFollow =
    existing.isInstalled &&
    Boolean(existing.autoUpdate) &&
    !breakingChange &&
    existing.installedVersion === existing.latestVersion;

  const nextInstalledVersion = installedShouldFollow
    ? input.version
    : existing.installedVersion;

  await db
    .update(skills)
    .set({
      name: nextName,
      description: nextDescription,
      content: nextContent,
      modelTags: nextModelTags,
      triggers: nextTriggers,
      category: nextCategory,
      latestVersion: input.version,
      installedVersion: nextInstalledVersion,
      changelog: input.changelog.trim(),
      breakingChange,
      minOpVersion: minOp,
      publishedAt: Date.now(),
      updateDismissedVersion: null,
      updatedAt: Date.now(),
      version: existing.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, skills),
        eq(skills.id, id),
        eq(skills.version, existing.version),
      ),
    );

  // Snapshot the freshly-published version (uses the post-update field set).
  await recordVersionSnapshot(
    ctx,
    {
      ...existing,
      name: nextName,
      description: nextDescription,
      content: nextContent,
      modelTags: nextModelTags,
      triggers: nextTriggers,
      category: nextCategory,
    },
    {
      semver: input.version,
      changelog: input.changelog.trim(),
      breakingChange,
      minOpVersion: minOp,
    },
  );

  if (installedShouldFollow) {
    await bumpVersionAdoption(ctx, id, input.version);
  }

  await logPrivacyEvent(ctx, {
    eventType: "skill.publish",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `slug=${existing.slug} version=${input.version} breaking=${breakingChange}`,
  });

  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

export async function listSkillVersions(
  ctx: TenantContext,
  id: string,
): Promise<SkillVersionRow[]> {
  const skill = await getSkill(ctx, id);
  if (!skill) throw new SkillNotFoundError(id);
  const rows = await db
    .select()
    .from(skillVersions)
    .where(and(tenantScope(ctx, skillVersions), eq(skillVersions.skillId, id)))
    .orderBy(desc(skillVersions.sortKey));
  return rows.map(toVersionRow);
}

/**
 * Roll the installed version back (or forward — used by "Apply update")
 * to the requested semver. The live skill row's content / model-tags /
 * etc are restored from the snapshot so subsequent agent runs use that
 * exact prompt.
 */
export async function rollbackSkill(
  ctx: TenantContext,
  id: string,
  targetSemver: string,
): Promise<SkillRow> {
  const liveRows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.id, id)))
    .limit(1);
  const live = liveRows[0];
  if (!live) throw new SkillNotFoundError(id);

  const snapRows = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        tenantScope(ctx, skillVersions),
        eq(skillVersions.skillId, id),
        eq(skillVersions.semver, targetSemver),
      ),
    )
    .limit(1);
  const snap = snapRows[0];
  if (!snap) {
    throw new SkillValidationError(
      `Version ${targetSemver} is not in this skill's history`,
    );
  }

  await db
    .update(skills)
    .set({
      // Restore the exact content the user trusted at that version.
      name: snap.name,
      description: snap.description,
      content: snap.content,
      modelTags: snap.modelTags,
      triggers: snap.triggers,
      category: snap.category,
      installedVersion: targetSemver,
      // Dismiss the update card for this version (and anything below).
      updateDismissedVersion: live.latestVersion,
      updatedAt: Date.now(),
      version: live.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, skills),
        eq(skills.id, id),
        eq(skills.version, live.version),
      ),
    );

  await bumpVersionAdoption(ctx, id, targetSemver);

  await logPrivacyEvent(ctx, {
    eventType: "skill.rollback",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `slug=${live.slug} from=${live.installedVersion} to=${targetSemver}`,
  });

  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

/**
 * Move the installed version up to `latestVersion`. Refuses to apply a
 * breaking change without an explicit `acceptBreaking` flag.
 */
export async function applySkillUpdate(
  ctx: TenantContext,
  id: string,
  options: { acceptBreaking?: boolean } = {},
): Promise<SkillRow> {
  const skill = await getSkill(ctx, id);
  if (!skill) throw new SkillNotFoundError(id);
  if (!skill.hasUpdate) return skill;
  if (skill.opIncompatible) {
    throw new SkillValidationError(
      `Update requires OP ${skill.minOpVersion} but this server runs ${getOpVersion()}`,
    );
  }
  if (skill.breakingChange && !options.acceptBreaking) {
    throw new SkillValidationError(
      "Breaking-change updates require explicit user approval (acceptBreaking=true)",
    );
  }
  return rollbackSkill(ctx, id, skill.latestVersion);
}

export async function dismissSkillUpdate(
  ctx: TenantContext,
  id: string,
): Promise<SkillRow> {
  const skill = await getSkill(ctx, id);
  if (!skill) throw new SkillNotFoundError(id);
  await db
    .update(skills)
    .set({
      updateDismissedVersion: skill.latestVersion,
      updatedAt: Date.now(),
      version: skill.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, skills),
        eq(skills.id, id),
        eq(skills.version, skill.version),
      ),
    );
  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

export async function setAutoUpdate(
  ctx: TenantContext,
  id: string,
  enabled: boolean,
): Promise<SkillRow> {
  const skill = await getSkill(ctx, id);
  if (!skill) throw new SkillNotFoundError(id);
  await db
    .update(skills)
    .set({
      autoUpdate: enabled,
      updatedAt: Date.now(),
      version: skill.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, skills),
        eq(skills.id, id),
        eq(skills.version, skill.version),
      ),
    );
  const row = await getSkill(ctx, id);
  if (!row) throw new SkillNotFoundError(id);
  return row;
}

export async function listSkillsWithUpdates(
  ctx: TenantContext,
): Promise<SkillRow[]> {
  const rows = await db
    .select()
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.isInstalled, true)))
    .orderBy(desc(skills.publishedAt));
  return rows.map(toRow).filter((r) => r.hasUpdate);
}

/**
 * Per-version adoption stats for the creator dashboard. `share` sums to
 * 1.0 (modulo float). The currently-published version is flagged
 * `isLatest` so the UI can highlight it.
 */
export async function getAdoptionStats(
  ctx: TenantContext,
  id: string,
): Promise<VersionAdoption[]> {
  const skill = await getSkill(ctx, id);
  if (!skill) throw new SkillNotFoundError(id);
  const versions = await listSkillVersions(ctx, id);
  const total = versions.reduce((acc, v) => acc + v.installCount, 0);
  return versions.map((v) => ({
    semver: v.semver,
    installCount: v.installCount,
    isLatest: v.semver === skill.latestVersion,
    isInstalled: skill.isInstalled && v.semver === skill.installedVersion,
    share: total > 0 ? v.installCount / total : 0,
  }));
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
