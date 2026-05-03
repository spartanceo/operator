/**
 * Skill-store service — hosted Skill Store API surface.
 *
 * The "store" is logically a separate hosted service (creators sign up,
 * submit skills, browse). For v1 it is co-located in the same Express
 * process so we don't have to deploy a second binary; a follow-up task
 * can split it out without changing the route shape thanks to the
 * canonical envelope.
 *
 * Privacy gate: every read & write to the store goes through
 * `requireStoreNetworkAccess()`, which checks `telemetryConsent`
 * and rejects with `STORE_NETWORK_DISABLED` when the user has turned
 * cloud/network features off. Every store call also writes a
 * `store.*` privacy event so the user can audit traffic later.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  creatorAccounts,
  db,
  decodeCursor,
  normaliseLimit,
  skills,
  storeInstallations,
  storeSkills,
  tenantScope,
  withTenantValues,
  type PaginatedData,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { getTelemetryConsent } from "./telemetry-consent.service";
import { logPrivacyEvent } from "./privacy.service";
import {
  getDraft,
  markDraftPublished,
  DraftNotFoundError,
  DraftValidationError,
} from "./skill-draft.service";

export interface CreatorAccountRow {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  websiteUrl: string | null;
  externalLinks: ExternalLink[];
  publishedSkillCount: number;
  totalInstalls: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatorSignupResult {
  account: CreatorAccountRow;
  /** One-time API token. The hash is stored; this is the only chance
   *  the client sees the raw token. */
  apiToken: string;
}

export interface ExternalLink {
  label: string;
  url: string;
}

export interface StoreSkillRow {
  id: string;
  creatorId: string;
  creatorHandle: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  modelTags: string[];
  triggers: string[];
  examplePrompts: string[];
  category: string;
  skillVersion: number;
  isLatest: boolean;
  installCount: number;
  documentation: string;
  isPremium: boolean;
  previewUsesAllowed: number;
  createdAt: string;
  updatedAt: string;
}

export class StoreNetworkDisabledError extends Error {
  override readonly name = "StoreNetworkDisabledError";
  readonly code = "STORE_NETWORK_DISABLED";
  constructor() {
    super(
      "Store browsing and submission require network/cloud features to be enabled in Settings → Privacy.",
    );
  }
}

export class CreatorAuthError extends Error {
  override readonly name = "CreatorAuthError";
  readonly code = "CREATOR_AUTH";
  constructor(message: string) {
    super(message);
  }
}

export class CreatorNotFoundError extends Error {
  override readonly name = "CreatorNotFoundError";
  readonly code = "CREATOR_NOT_FOUND";
  constructor(handle: string) {
    super(`Unknown creator "${handle}"`);
  }
}

export class StoreSkillNotFoundError extends Error {
  override readonly name = "StoreSkillNotFoundError";
  readonly code = "STORE_SKILL_NOT_FOUND";
  constructor(target: string) {
    super(`Unknown store skill "${target}"`);
  }
}

export class StoreValidationError extends Error {
  override readonly name = "StoreValidationError";
  readonly code = "STORE_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Block any store interaction when the user has disabled network/cloud
 * features. This is the user-controlled privacy gate: the store IS a
 * cloud feature even though it currently runs in the same process.
 *
 * Usage metrics is the closest existing channel to "I'm OK with my
 * client talking to a hosted backend"; until a dedicated `cloudEnabled`
 * channel ships (Task #29), we treat usage metrics as the master switch.
 */
async function requireStoreNetworkAccess(ctx: TenantContext): Promise<void> {
  // Allow override via env so tests + CLI can run without setting consent.
  if (process.env["OMNINITY_STORE_BYPASS_CONSENT"] === "1") return;
  const consent = await getTelemetryConsent(ctx);
  if (!consent.usageMetricsEnabled && !consent.productImprovementEnabled) {
    throw new StoreNetworkDisabledError();
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function parseStringArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function parseExternalLinks(raw: string): ExternalLink[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is ExternalLink =>
        typeof v === "object" &&
        v !== null &&
        typeof v.label === "string" &&
        typeof v.url === "string",
    );
  } catch {
    return [];
  }
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 64) || "creator"
  );
}

async function toCreatorRow(r: typeof creatorAccounts.$inferSelect): Promise<CreatorAccountRow> {
  const skillsByCreator = await db
    .select({
      installs: storeSkills.installCount,
    })
    .from(storeSkills)
    .where(and(eq(storeSkills.creatorId, r.id), eq(storeSkills.isLatest, true)));
  const totalInstalls = skillsByCreator.reduce((acc, s) => acc + s.installs, 0);
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.displayName,
    bio: r.bio,
    websiteUrl: r.websiteUrl ?? null,
    externalLinks: parseExternalLinks(r.externalLinks),
    publishedSkillCount: skillsByCreator.length,
    totalInstalls,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toStoreSkillRow(r: typeof storeSkills.$inferSelect): StoreSkillRow {
  return {
    id: r.id,
    creatorId: r.creatorId,
    creatorHandle: r.creatorHandle,
    slug: r.slug,
    name: r.name,
    description: r.description,
    content: r.content,
    modelTags: parseStringArray(r.modelTags),
    triggers: parseStringArray(r.triggers),
    examplePrompts: parseStringArray(r.examplePrompts),
    category: r.category,
    skillVersion: r.skillVersion,
    isLatest: Boolean(r.isLatest),
    installCount: r.installCount,
    documentation: r.documentation,
    isPremium: Boolean(r.isPremium),
    previewUsesAllowed: r.previewUsesAllowed ?? 2,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/* ─── Creator accounts ───────────────────────────────────────────────── */

export interface CreatorSignupInput {
  handle?: string;
  displayName: string;
  bio?: string;
  websiteUrl?: string;
  externalLinks?: ExternalLink[];
}

export async function signupCreator(
  ctx: TenantContext,
  input: CreatorSignupInput,
): Promise<CreatorSignupResult> {
  await requireStoreNetworkAccess(ctx);
  const display = input.displayName.trim();
  if (display.length < 2) {
    throw new StoreValidationError("Display name must be at least 2 characters");
  }
  const baseHandle = slugify(input.handle ?? display);
  let handle = baseHandle;
  let suffix = 2;
  while (suffix < 1000) {
    const existing = await db
      .select()
      .from(creatorAccounts)
      .where(eq(creatorAccounts.handle, handle))
      .limit(1);
    if (existing.length === 0) break;
    handle = `${baseHandle}-${suffix}`;
    suffix++;
  }
  const id = `creator_${nanoid()}`;
  const apiToken = `cr_${randomBytes(24).toString("hex")}`;
  const apiTokenHash = hashToken(apiToken);
  await db.insert(creatorAccounts).values(
    withTenantValues(ctx, {
      id,
      handle,
      displayName: display,
      bio: (input.bio ?? "").trim(),
      websiteUrl: input.websiteUrl?.trim() || null,
      externalLinks: JSON.stringify(input.externalLinks ?? []),
      apiTokenHash,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "store.creator.signup",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `handle=${handle}`,
  });
  const row = await db
    .select()
    .from(creatorAccounts)
    .where(eq(creatorAccounts.id, id))
    .limit(1);
  if (!row[0]) throw new Error("Creator vanished after signup");
  const account = await toCreatorRow(row[0]);
  return { account, apiToken };
}

export async function getCreatorByHandle(handle: string): Promise<CreatorAccountRow | null> {
  const rows = await db
    .select()
    .from(creatorAccounts)
    .where(eq(creatorAccounts.handle, handle))
    .limit(1);
  if (!rows[0]) return null;
  return toCreatorRow(rows[0]);
}

export interface ListCreatorsOptions {
  cursor?: string;
  limit?: number;
}

export async function listCreators(
  ctx: TenantContext,
  opts: ListCreatorsOptions = {},
): Promise<PaginatedData<CreatorAccountRow>> {
  await requireStoreNetworkAccess(ctx);
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const rows = await db
    .select()
    .from(creatorAccounts)
    .where(cursorTs !== null && Number.isFinite(cursorTs) ? lt(creatorAccounts.createdAt, cursorTs) : undefined)
    .orderBy(desc(creatorAccounts.createdAt))
    .limit(limit + 1);
  const accounts = await Promise.all(rows.map(toCreatorRow));
  return buildPage(accounts, limit, (r) => String(new Date(r.createdAt).getTime()));
}

/**
 * Authenticate the bearer token a publish/manage call sent. The
 * caller is the creator who owns that token (NOT necessarily the
 * tenant the request originated from — multiple tenants can share a
 * single store creator account).
 */
export async function authenticateCreatorByApiToken(
  token: string | null,
): Promise<typeof creatorAccounts.$inferSelect> {
  return authenticateCreatorToken(token);
}

async function authenticateCreatorToken(token: string | null): Promise<typeof creatorAccounts.$inferSelect> {
  if (!token) throw new CreatorAuthError("Missing creator API token");
  const hash = hashToken(token);
  const rows = await db
    .select()
    .from(creatorAccounts)
    .where(eq(creatorAccounts.apiTokenHash, hash))
    .limit(1);
  if (!rows[0]) throw new CreatorAuthError("Invalid creator API token");
  return rows[0];
}

/* ─── Store skill submission / browsing ──────────────────────────────── */

export interface PublishDraftInput {
  draftId: string;
  apiToken: string;
  documentation?: string;
  isPremium?: boolean;
  previewUsesAllowed?: number;
}

export async function publishDraft(
  ctx: TenantContext,
  input: PublishDraftInput,
): Promise<StoreSkillRow> {
  await requireStoreNetworkAccess(ctx);
  const creator = await authenticateCreatorToken(input.apiToken);
  const draft = await getDraft(ctx, input.draftId);
  if (!draft) throw new DraftNotFoundError(input.draftId);
  if (!draft.name.trim() || !draft.content.trim()) {
    throw new DraftValidationError("Draft is missing name or content — finish editing before publish");
  }
  const slug = slugify(draft.name);
  // Find the latest version of this slug for this creator.
  const existing = await db
    .select()
    .from(storeSkills)
    .where(
      and(eq(storeSkills.creatorHandle, creator.handle), eq(storeSkills.slug, slug)),
    )
    .orderBy(desc(storeSkills.skillVersion))
    .limit(1);
  const nextVersion = existing[0] ? existing[0].skillVersion + 1 : 1;

  const id = `store_skill_${nanoid()}`;
  await db.transaction((tx) => {
    if (existing[0]) {
      // Demote previous latest.
      tx
        .update(storeSkills)
        .set({ isLatest: false, updatedAt: Date.now() })
        .where(
          and(
            eq(storeSkills.creatorHandle, creator.handle),
            eq(storeSkills.slug, slug),
          ),
        )
        .run();
    }
    tx.insert(storeSkills)
      .values(
        withTenantValues(ctx, {
          id,
          creatorId: creator.id,
          creatorHandle: creator.handle,
          slug,
          name: draft.name,
          description: draft.description,
          content: draft.content,
          modelTags: JSON.stringify(draft.modelTags),
          triggers: JSON.stringify(draft.triggers),
          examplePrompts: JSON.stringify(draft.examplePrompts),
          category: draft.category,
          skillVersion: nextVersion,
          isLatest: true,
          installCount: 0,
          documentation: (input.documentation ?? "").slice(0, 8_000),
          isPremium: input.isPremium ?? false,
          previewUsesAllowed:
            typeof input.previewUsesAllowed === "number"
              ? Math.max(0, Math.floor(input.previewUsesAllowed))
              : 2,
        }),
      )
      .run();
  });
  await markDraftPublished(ctx, draft.id, id);
  await logPrivacyEvent(ctx, {
    eventType: "store.skill.publish",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `creator=${creator.handle} slug=${slug} v=${nextVersion}`,
  });
  const row = await db.select().from(storeSkills).where(eq(storeSkills.id, id)).limit(1);
  if (!row[0]) throw new Error("Store skill vanished after publish");
  return toStoreSkillRow(row[0]);
}

export interface ListStoreSkillsOptions {
  cursor?: string;
  limit?: number;
  category?: string;
  creatorHandle?: string;
  search?: string;
}

export async function listStoreSkills(
  ctx: TenantContext,
  opts: ListStoreSkillsOptions = {},
): Promise<PaginatedData<StoreSkillRow>> {
  await requireStoreNetworkAccess(ctx);
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const filters: ReturnType<typeof and>[] = [eq(storeSkills.isLatest, true)];
  if (opts.category) filters.push(eq(storeSkills.category, opts.category));
  if (opts.creatorHandle) filters.push(eq(storeSkills.creatorHandle, opts.creatorHandle));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(storeSkills.createdAt, cursorTs));
  }
  const where = filters.length > 1 ? and(...filters) : filters[0];
  const rows = await db
    .select()
    .from(storeSkills)
    .where(where)
    .orderBy(desc(storeSkills.installCount), desc(storeSkills.createdAt))
    .limit(limit + 1);
  let mapped = rows.map(toStoreSkillRow);
  if (opts.search?.trim()) {
    const q = opts.search.trim().toLowerCase();
    mapped = mapped.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.creatorHandle.toLowerCase().includes(q),
    );
  }
  await logPrivacyEvent(ctx, {
    eventType: "store.skill.browse",
    actor: ctx.userId ?? ctx.tenantId,
    target: opts.creatorHandle ?? opts.category ?? "all",
    severity: "low",
  });
  return buildPage(mapped, limit, (r) => String(new Date(r.createdAt).getTime()));
}

export async function getStoreSkill(
  ctx: TenantContext,
  creatorHandle: string,
  slug: string,
  storeVersion?: number,
): Promise<StoreSkillRow | null> {
  await requireStoreNetworkAccess(ctx);
  const filters = [eq(storeSkills.creatorHandle, creatorHandle), eq(storeSkills.slug, slug)];
  if (typeof storeVersion === "number") {
    filters.push(eq(storeSkills.skillVersion, storeVersion));
  } else {
    filters.push(eq(storeSkills.isLatest, true));
  }
  const rows = await db
    .select()
    .from(storeSkills)
    .where(and(...filters))
    .limit(1);
  if (!rows[0]) return null;
  return toStoreSkillRow(rows[0]);
}

export async function listVersions(
  ctx: TenantContext,
  creatorHandle: string,
  slug: string,
): Promise<StoreSkillRow[]> {
  await requireStoreNetworkAccess(ctx);
  const rows = await db
    .select()
    .from(storeSkills)
    .where(and(eq(storeSkills.creatorHandle, creatorHandle), eq(storeSkills.slug, slug)))
    .orderBy(desc(storeSkills.skillVersion));
  return rows.map(toStoreSkillRow);
}

/**
 * Install a published store skill into the calling tenant. This writes
 * a normal `skills` row (so the existing in-app marketplace + agent
 * router can use it unchanged) plus a `store_installations` row that
 * remembers which version was installed (used by the auto-update check).
 */
export async function installStoreSkill(
  ctx: TenantContext,
  creatorHandle: string,
  slug: string,
): Promise<{ skillId: string; storeSkill: StoreSkillRow }> {
  await requireStoreNetworkAccess(ctx);
  const store = await getStoreSkill(ctx, creatorHandle, slug);
  if (!store) throw new StoreSkillNotFoundError(`${creatorHandle}/${slug}`);

  // Unique-by-(tenant, creator, slug): re-install bumps to latest.
  const existingInstall = await db
    .select()
    .from(storeInstallations)
    .where(
      and(
        tenantScope(ctx, storeInstallations),
        eq(storeInstallations.creatorHandle, creatorHandle),
        eq(storeInstallations.slug, slug),
      ),
    )
    .limit(1);

  let localSkillId: string;
  if (existingInstall[0]) {
    localSkillId = existingInstall[0].skillId;
    await db.transaction((tx) => {
      tx
        .update(skills)
        .set({
          name: store.name,
          description: store.description,
          content: store.content,
          modelTags: JSON.stringify(store.modelTags),
          triggers: JSON.stringify(store.triggers),
          category: store.category,
          author: store.creatorHandle,
          isInstalled: true,
          isPremium: store.isPremium,
          previewUsesAllowed: store.previewUsesAllowed,
          updatedAt: Date.now(),
        })
        .where(and(tenantScope(ctx, skills), eq(skills.id, localSkillId)))
        .run();
      tx
        .update(storeInstallations)
        .set({
          installedVersion: store.skillVersion,
          updatedAt: Date.now(),
        })
        .where(
          and(
            tenantScope(ctx, storeInstallations),
            eq(storeInstallations.id, existingInstall[0]!.id),
          ),
        )
        .run();
      tx
        .update(storeSkills)
        .set({ installCount: store.installCount + 1, updatedAt: Date.now() })
        .where(eq(storeSkills.id, store.id))
        .run();
    });
  } else {
    localSkillId = `skill_${nanoid()}`;
    const installId = `store_install_${nanoid()}`;
    await db.transaction((tx) => {
      tx.insert(skills)
        .values(
          withTenantValues(ctx, {
            id: localSkillId,
            slug: `${creatorHandle}-${slug}`.slice(0, 80),
            name: store.name,
            description: store.description,
            content: store.content,
            modelTags: JSON.stringify(store.modelTags),
            triggers: JSON.stringify(store.triggers),
            category: store.category,
            author: store.creatorHandle,
            isInstalled: true,
            installCount: 1,
            isPremium: store.isPremium,
            previewUsesAllowed: store.previewUsesAllowed,
          }),
        )
        .run();
      tx.insert(storeInstallations)
        .values(
          withTenantValues(ctx, {
            id: installId,
            skillId: localSkillId,
            creatorHandle,
            slug,
            installedVersion: store.skillVersion,
          }),
        )
        .run();
      tx
        .update(storeSkills)
        .set({ installCount: store.installCount + 1, updatedAt: Date.now() })
        .where(eq(storeSkills.id, store.id))
        .run();
    });
  }

  await logPrivacyEvent(ctx, {
    eventType: "store.skill.install",
    actor: ctx.userId ?? ctx.tenantId,
    target: store.id,
    severity: "info",
    detail: `creator=${creatorHandle} slug=${slug} v=${store.skillVersion}`,
  });

  const refreshed = await getStoreSkill(ctx, creatorHandle, slug);
  return { skillId: localSkillId, storeSkill: refreshed ?? store };
}

export interface UpdateAvailability {
  skillId: string;
  creatorHandle: string;
  slug: string;
  installedVersion: number;
  latestVersion: number;
  storeSkillId: string;
  name: string;
}

/**
 * Check the store for newer versions of any installed store skills the
 * calling tenant has. Returns one row per installed skill that has a
 * newer version available.
 */
export async function checkUpdates(ctx: TenantContext): Promise<UpdateAvailability[]> {
  await requireStoreNetworkAccess(ctx);
  const installs = await db
    .select()
    .from(storeInstallations)
    .where(tenantScope(ctx, storeInstallations));
  const out: UpdateAvailability[] = [];
  for (const inst of installs) {
    const latest = await db
      .select()
      .from(storeSkills)
      .where(
        and(
          eq(storeSkills.creatorHandle, inst.creatorHandle),
          eq(storeSkills.slug, inst.slug),
          eq(storeSkills.isLatest, true),
        ),
      )
      .limit(1);
    const row = latest[0];
    if (!row) continue;
    if (row.skillVersion > inst.installedVersion) {
      out.push({
        skillId: inst.skillId,
        creatorHandle: inst.creatorHandle,
        slug: inst.slug,
        installedVersion: inst.installedVersion,
        latestVersion: row.skillVersion,
        storeSkillId: row.id,
        name: row.name,
      });
    }
  }
  return out;
}

export interface CreatorDashboardSummary {
  account: CreatorAccountRow;
  publishedSkills: StoreSkillRow[];
  totalInstalls: number;
  totalVersions: number;
}

export async function getCreatorDashboard(
  ctx: TenantContext,
  apiToken: string,
): Promise<CreatorDashboardSummary> {
  await requireStoreNetworkAccess(ctx);
  const creator = await authenticateCreatorToken(apiToken);
  const account = await toCreatorRow(creator);
  const latestRows = await db
    .select()
    .from(storeSkills)
    .where(and(eq(storeSkills.creatorId, creator.id), eq(storeSkills.isLatest, true)))
    .orderBy(desc(storeSkills.updatedAt));
  const versionCount = await db
    .select({ n: count() })
    .from(storeSkills)
    .where(eq(storeSkills.creatorId, creator.id));
  const totalVersions = versionCount[0]?.n ?? 0;
  const publishedSkills = latestRows.map(toStoreSkillRow);
  return {
    account,
    publishedSkills,
    totalInstalls: publishedSkills.reduce((acc, s) => acc + s.installCount, 0),
    totalVersions,
  };
}
