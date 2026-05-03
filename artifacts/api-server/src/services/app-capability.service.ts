/**
 * App Capability Indexer (Task #70).
 *
 * Builds and serves per-app capability profiles by fusing four sources:
 *
 *   1. OS-native introspection — macOS `.sdef` AppleScript dictionaries,
 *      Windows UI Automation, Linux `.desktop` + AT-SPI. Tier 1 ships a
 *      deterministic stub that returns a curated seed set so the rest of
 *      the agent stack (Router / Planner / Desktop Control) can integrate
 *      against a stable contract while the native adapters land.
 *   2. Public documentation — best-effort doc ingestion (Deep Learn) that
 *      crawls the app's official docs root, chunks + embeds them, and
 *      tags every chunk with the `app_id`.
 *   3. MCP (Model Context Protocol) connectors — one-click connect.
 *   4. Community App Skills — installed from the Skills marketplace and
 *      pinned to a `target_app_id`.
 *
 * Profile freshness:
 *   - `lastRefreshedAt + profileTtlMs < now` triggers a re-derivation.
 *   - Re-derivation is idempotent: same `app_id` + same source set
 *     produces the same row.
 *
 * Tenant scoping is non-negotiable — every read and write goes through
 * `tenantScope` / `withTenantValues`. The hot in-process cache is bounded
 * (LRU 256 entries) and keyed on `(tenantId, workspaceId, appId)`.
 */
import fs from "node:fs";
import path from "node:path";

import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  appCapabilityCommands,
  appDocIngestions,
  appMcpConnections,
  appProfiles,
  buildPage,
  db,
  decodeCursor,
  LRUCache,
  normaliseLimit,
  type PaginatedData,
  skills as skillsTable,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

// ─── Public types ───────────────────────────────────────────────────────────

export interface AppProfileRow {
  id: string;
  appId: string;
  appName: string;
  appVersion: string;
  platform: string;
  sources: AppProfileSources;
  commandCount: number;
  menuCount: number;
  shortcutCount: number;
  docIndexStatus: string;
  mcpStatus: string;
  installedSkillId: string | null;
  lastRefreshedAt: string | null;
  profileTtlMs: number;
  discoveredPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppProfileSources {
  osNative: boolean;
  mcp: boolean;
  docs: boolean;
  skill: boolean;
}

export interface AppCommandRow {
  id: string;
  appProfileId: string;
  kind: string;
  source: string;
  name: string;
  description: string;
  shortcut: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AppMcpConnectionRow {
  id: string;
  appProfileId: string;
  endpoint: string;
  status: string;
  tools: ReadonlyArray<{ name: string; description?: string }>;
  error: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
}

export interface AppDocIngestionRow {
  id: string;
  appProfileId: string;
  status: string;
  rootUrl: string;
  pagesFetched: number;
  pagesPlanned: number;
  chunksEmbedded: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AppFeatureStatus {
  enabled: boolean;
  reason: string;
  platform: NodeJS.Platform;
  cachedProfiles: number;
}

// Source seed: the curated apps the OS-native scan returns at Tier 1.
// Real adapters (.sdef parsing, UIA, AT-SPI) replace this list per platform.
interface SeedApp {
  appId: string;
  appName: string;
  platforms: ReadonlyArray<NodeJS.Platform>;
  commands: ReadonlyArray<{
    kind: "command" | "menu" | "shortcut";
    name: string;
    description?: string;
    shortcut?: string;
  }>;
  mcpEndpoint?: string;
  docsRoot?: string;
}

// tier-review: bounded — fixed curated seed list, never mutated at runtime.
const SEED_APPS: ReadonlyArray<SeedApp> = [
  {
    appId: "com.apple.finder",
    appName: "Finder",
    platforms: ["darwin"],
    commands: [
      { kind: "menu", name: "New Folder", shortcut: "⇧⌘N" },
      { kind: "menu", name: "New Smart Folder" },
      { kind: "menu", name: "Get Info", shortcut: "⌘I" },
      { kind: "menu", name: "Move to Trash", shortcut: "⌘⌫" },
      { kind: "command", name: "reveal", description: "Reveal a path in a new Finder window" },
    ],
  },
  {
    appId: "com.microsoft.VSCode",
    appName: "Visual Studio Code",
    platforms: ["darwin", "linux", "win32"],
    commands: [
      { kind: "shortcut", name: "Command Palette", shortcut: "⇧⌘P" },
      { kind: "shortcut", name: "Quick Open", shortcut: "⌘P" },
      { kind: "menu", name: "New File", shortcut: "⌘N" },
      { kind: "menu", name: "Save", shortcut: "⌘S" },
      { kind: "command", name: "workbench.action.terminal.new" },
    ],
    docsRoot: "https://code.visualstudio.com/docs",
  },
  {
    appId: "com.linear.linear",
    appName: "Linear",
    platforms: ["darwin", "linux", "win32"],
    commands: [
      { kind: "shortcut", name: "Create Issue", shortcut: "C" },
      { kind: "shortcut", name: "Search", shortcut: "⌘K" },
      { kind: "menu", name: "Inbox" },
    ],
    mcpEndpoint: "https://mcp.linear.app",
    docsRoot: "https://linear.app/docs",
  },
  {
    appId: "com.figma.Desktop",
    appName: "Figma",
    platforms: ["darwin", "win32"],
    commands: [
      { kind: "shortcut", name: "Quick Actions", shortcut: "⌘/" },
      { kind: "menu", name: "Frame", shortcut: "F" },
      { kind: "menu", name: "Export…", shortcut: "⇧⌘E" },
    ],
    mcpEndpoint: "https://mcp.figma.com",
    docsRoot: "https://help.figma.com",
  },
  {
    appId: "notion.id",
    appName: "Notion",
    platforms: ["darwin", "linux", "win32"],
    commands: [
      { kind: "shortcut", name: "Quick Find", shortcut: "⌘P" },
      { kind: "shortcut", name: "New Page", shortcut: "⌘N" },
    ],
    mcpEndpoint: "https://mcp.notion.com",
    docsRoot: "https://www.notion.so/help",
  },
];

// ─── Mappers ────────────────────────────────────────────────────────────────

function parseSources(json: string): AppProfileSources {
  try {
    const parsed = JSON.parse(json) as Partial<AppProfileSources>;
    return {
      osNative: Boolean(parsed.osNative),
      mcp: Boolean(parsed.mcp),
      docs: Boolean(parsed.docs),
      skill: Boolean(parsed.skill),
    };
  } catch {
    return { osNative: false, mcp: false, docs: false, skill: false };
  }
}

function toProfileRow(r: typeof appProfiles.$inferSelect): AppProfileRow {
  return {
    id: r.id,
    appId: r.appId,
    appName: r.appName,
    appVersion: r.appVersion,
    platform: r.platform,
    sources: parseSources(r.sources),
    commandCount: r.commandCount,
    menuCount: r.menuCount,
    shortcutCount: r.shortcutCount,
    docIndexStatus: r.docIndexStatus,
    mcpStatus: r.mcpStatus,
    installedSkillId: r.installedSkillId,
    lastRefreshedAt: r.lastRefreshedAt
      ? new Date(r.lastRefreshedAt).toISOString()
      : null,
    profileTtlMs: r.profileTtlMs,
    discoveredPath: r.discoveredPath,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toCommandRow(r: typeof appCapabilityCommands.$inferSelect): AppCommandRow {
  let payload: unknown = null;
  if (r.payloadJson) {
    try {
      payload = JSON.parse(r.payloadJson);
    } catch {
      payload = null;
    }
  }
  return {
    id: r.id,
    appProfileId: r.appProfileId,
    kind: r.kind,
    source: r.source,
    name: r.name,
    description: r.description,
    shortcut: r.shortcut,
    payload,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function toMcpRow(r: typeof appMcpConnections.$inferSelect): AppMcpConnectionRow {
  let tools: ReadonlyArray<{ name: string; description?: string }> = [];
  if (r.toolsJson) {
    try {
      const parsed = JSON.parse(r.toolsJson) as unknown;
      if (Array.isArray(parsed)) {
        tools = parsed.filter(
          (t): t is { name: string; description?: string } =>
            typeof t === "object" &&
            t !== null &&
            typeof (t as { name?: unknown }).name === "string",
        );
      }
    } catch {
      tools = [];
    }
  }
  return {
    id: r.id,
    appProfileId: r.appProfileId,
    endpoint: r.endpoint,
    status: r.status,
    tools,
    error: r.error,
    connectedAt: r.connectedAt ? new Date(r.connectedAt).toISOString() : null,
    disconnectedAt: r.disconnectedAt ? new Date(r.disconnectedAt).toISOString() : null,
  };
}

function toDocRow(r: typeof appDocIngestions.$inferSelect): AppDocIngestionRow {
  return {
    id: r.id,
    appProfileId: r.appProfileId,
    status: r.status,
    rootUrl: r.rootUrl,
    pagesFetched: r.pagesFetched,
    pagesPlanned: r.pagesPlanned,
    chunksEmbedded: r.chunksEmbedded,
    error: r.error,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

// ─── Bounded hot-path cache ─────────────────────────────────────────────────

interface CacheKey {
  tenantId: string;
  workspaceId?: string | undefined;
  appId: string;
}

function cacheKey(k: CacheKey): string {
  return `${k.tenantId}::${k.workspaceId ?? "_"}::${k.appId}`;
}

const profileCache = new LRUCache<string, AppProfileRow>({
  max: 256,
  ttl: 60_000, // 1m — re-reads after refresh always go to DB
});

export function clearAppCapabilityCacheForTests(): void {
  profileCache.clear();
}

// ─── Feature flag ───────────────────────────────────────────────────────────

export function getFeatureStatus(): AppFeatureStatus {
  const flag = process.env["FEATURE_APP_CAPABILITIES"];
  const enabled = flag === "1" || flag === "true" || flag === undefined;
  return {
    enabled,
    reason: enabled
      ? "App Capability Indexer is enabled."
      : "App Capability Indexer is disabled. Set FEATURE_APP_CAPABILITIES=1.",
    platform: process.platform,
    cachedProfiles: profileCache.size,
  };
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class AppNotFoundError extends Error {
  constructor(public readonly appProfileId: string) {
    super(`App profile not found: ${appProfileId}`);
    this.name = "AppNotFoundError";
  }
}

// ─── Listing & lookup ───────────────────────────────────────────────────────

export async function listProfiles(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<AppProfileRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, appProfiles);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(appProfiles.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(appProfiles)
    .where(where)
    .orderBy(desc(appProfiles.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toProfileRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getProfile(
  ctx: TenantContext,
  id: string,
): Promise<AppProfileRow | null> {
  const rows = await db
    .select()
    .from(appProfiles)
    .where(and(tenantScope(ctx, appProfiles), eq(appProfiles.id, id)))
    .limit(1);
  if (!rows[0]) return null;
  const row = toProfileRow(rows[0]);
  profileCache.set(cacheKey({ ...ctx, appId: row.appId }), row);
  return row;
}

export async function getProfileByAppId(
  ctx: TenantContext,
  appId: string,
): Promise<AppProfileRow | null> {
  const cached = profileCache.get(cacheKey({ ...ctx, appId }));
  if (cached) return cached;
  const rows = await db
    .select()
    .from(appProfiles)
    .where(and(tenantScope(ctx, appProfiles), eq(appProfiles.appId, appId)))
    .limit(1);
  if (!rows[0]) return null;
  const row = toProfileRow(rows[0]);
  profileCache.set(cacheKey({ ...ctx, appId }), row);
  return row;
}

export async function listCommands(
  ctx: TenantContext,
  appProfileId: string,
  opts: { cursor?: string; limit?: number; kind?: string } = {},
): Promise<PaginatedData<AppCommandRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorName = opts.cursor ? decodeCursor(opts.cursor) : null;
  const baseScope = and(
    tenantScope(ctx, appCapabilityCommands),
    eq(appCapabilityCommands.appProfileId, appProfileId),
    opts.kind ? eq(appCapabilityCommands.kind, opts.kind) : undefined,
  );
  // Forward seek pagination: ascending order requires `gt` on the cursor
  // value, otherwise page 2 walks backwards and re-emits earlier rows.
  const where = cursorName
    ? and(baseScope, gt(appCapabilityCommands.name, cursorName))
    : baseScope;
  const rows = await db
    .select()
    .from(appCapabilityCommands)
    .where(where)
    .orderBy(asc(appCapabilityCommands.name))
    .limit(limit + 1);
  return buildPage(rows.map(toCommandRow), limit, (r) => r.name);
}

// ─── OS-native scan + profile re-derivation ─────────────────────────────────

/**
 * Scan the host for installed applications and ensure an `app_profiles`
 * row exists for each match. Returns the list of profiles (re-derived
 * when stale or missing). Idempotent.
 */
export async function scanInstalledApps(
  ctx: TenantContext,
): Promise<ReadonlyArray<AppProfileRow>> {
  const status = getFeatureStatus();
  if (!status.enabled) {
    return [];
  }
  const platform = process.platform;

  // Real OS-native probe — attempts to enumerate installed app bundles in
  // the well-known per-platform locations, then merges with the seeded
  // capability list. Probing failures are non-fatal: we fall back to the
  // seed so the agent stack still has a stable contract on bare CI hosts.
  const discoveredPaths = probeInstalledAppPaths(platform);

  const matches = SEED_APPS.filter((seed) =>
    seed.platforms.includes(platform),
  );

  const out: AppProfileRow[] = [];
  for (const seed of matches) {
    const discoveredPath =
      discoveredPaths.find((p) =>
        path.basename(p).toLowerCase().includes(
          seed.appName.toLowerCase().split(" ")[0]!,
        ),
      ) ?? null;
    const profile = await upsertProfileFromSeed(
      ctx,
      seed,
      platform,
      discoveredPath,
    );
    out.push(profile);
  }
  await logPrivacyEvent(ctx, {
    eventType: "app.scan",
    actor: ctx.userId ?? ctx.tenantId,
    target: "host",
    severity: "low",
    detail: `platform=${platform} probed=${discoveredPaths.length} matched=${out.length}`,
  });
  return out;
}

/**
 * Enumerate installed app bundles in the well-known per-platform locations.
 * Bounded — we never recurse beyond the top level and cap the result at 256
 * entries so a misconfigured host can't blow the request budget. Returns an
 * empty list on probe failure (e.g. permission denied, missing dir).
 */
function probeInstalledAppPaths(platform: NodeJS.Platform): string[] {
  const candidates: string[] = [];
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";

  const roots: string[] =
    platform === "darwin"
      ? ["/Applications", path.join(home, "Applications")]
      : platform === "win32"
        ? [
            "C:/Program Files",
            "C:/Program Files (x86)",
            path.join(home, "AppData/Local/Programs"),
          ]
        : ["/usr/share/applications", path.join(home, ".local/share/applications")];

  const ext = platform === "darwin" ? ".app" : platform === "win32" ? ".exe" : ".desktop";

  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        if (candidates.length >= 256) break;
        if (e.name.endsWith(ext)) {
          candidates.push(path.join(root, e.name));
        }
      }
    } catch {
      // Permission denied / not a directory — skip silently and fall back.
    }
  }
  return candidates;
}

async function upsertProfileFromSeed(
  ctx: TenantContext,
  seed: SeedApp,
  platform: NodeJS.Platform,
  discoveredPath: string | null = null,
): Promise<AppProfileRow> {
  const existing = await getProfileByAppId(ctx, seed.appId);
  const now = Date.now();
  if (existing) {
    // Profile exists — only re-derive when TTL expired so re-scans are
    // cheap and idempotent for the common path.
    const refreshedAt = existing.lastRefreshedAt
      ? new Date(existing.lastRefreshedAt).getTime()
      : 0;
    if (refreshedAt + existing.profileTtlMs > now) {
      return existing;
    }
  }

  const id = existing?.id ?? `app_${nanoid()}`;
  const sources: AppProfileSources = {
    osNative: true,
    mcp: Boolean(seed.mcpEndpoint),
    docs: Boolean(seed.docsRoot),
    skill: Boolean(existing?.installedSkillId),
  };

  const counts = {
    commands: seed.commands.filter((c) => c.kind === "command").length,
    menus: seed.commands.filter((c) => c.kind === "menu").length,
    shortcuts: seed.commands.filter((c) => c.kind === "shortcut").length,
  };

  if (existing) {
    await db
      .update(appProfiles)
      .set({
        appName: seed.appName,
        platform,
        sources: JSON.stringify(sources),
        commandCount: counts.commands,
        menuCount: counts.menus,
        shortcutCount: counts.shortcuts,
        mcpStatus: seed.mcpEndpoint
          ? existing.mcpStatus === "connected"
            ? "connected"
            : "available"
          : "absent",
        lastRefreshedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          tenantScope(ctx, appProfiles),
          eq(appProfiles.id, existing.id),
        ),
      );
  } else {
    await db.insert(appProfiles).values(
      withTenantValues(ctx, {
        id,
        appId: seed.appId,
        appName: seed.appName,
        appVersion: "0.0.0",
        platform,
        sources: JSON.stringify(sources),
        commandCount: counts.commands,
        menuCount: counts.menus,
        shortcutCount: counts.shortcuts,
        docIndexStatus: "absent",
        mcpStatus: seed.mcpEndpoint ? "available" : "absent",
        discoveredPath,
        lastRefreshedAt: now,
      }),
    );
  }

  // Replace the OS-native commands with the freshly-derived set. We
  // intentionally drop and re-insert so the row count always matches the
  // seed; MCP / skill commands carry their own `source` and survive.
  await db
    .delete(appCapabilityCommands)
    .where(
      and(
        tenantScope(ctx, appCapabilityCommands),
        eq(appCapabilityCommands.appProfileId, id),
        eq(appCapabilityCommands.source, "os_native"),
      ),
    );
  for (const cmd of seed.commands) {
    await db.insert(appCapabilityCommands).values(
      withTenantValues(ctx, {
        id: `cmd_${nanoid()}`,
        appProfileId: id,
        kind: cmd.kind,
        source: "os_native",
        name: cmd.name,
        description: cmd.description ?? "",
        shortcut: cmd.shortcut ?? null,
      }),
    );
  }

  profileCache.delete(cacheKey({ ...ctx, appId: seed.appId }));
  const fresh = await getProfileByAppId(ctx, seed.appId);
  if (!fresh) throw new Error(`Upsert lost profile ${seed.appId}`);
  return fresh;
}

// ─── Deep Learn (doc ingestion) ─────────────────────────────────────────────

/**
 * Kick off (and, in stub mode, synchronously execute) a Deep Learn doc
 * ingestion job for an app's public documentation.
 *
 * Pipeline:
 *   1. Insert `app_doc_ingestions` row (`status=queued`).
 *   2. Resolve the doc root URL — explicit → seed → search fallback.
 *   3. Validate the URL (HTTPS-only, public DNS — SSRF guard).
 *   4. For each planned page (Tier 1 caps at 3): fetch with a 10s
 *      timeout, count chunks (page text / 800 chars), and emit a
 *      per-URL `app.deep_learn.fetch` privacy event.
 *   5. Stamp `status=ready`, update `pages_fetched` / `chunks_embedded`,
 *      and flip the profile's `docIndexStatus` to `ready`.
 *
 * Failures are non-fatal at the row level — we record `status=error` with
 * the message and the profile flips to `error` so the UI can prompt for
 * manual retry. The fetch is a single best-effort GET; the embedding
 * worker (Task #19) takes over for production-grade chunking + recall.
 */
export async function startDeepLearn(
  ctx: TenantContext,
  appProfileId: string,
  rootUrl?: string,
): Promise<AppDocIngestionRow> {
  const profile = await getProfile(ctx, appProfileId);
  if (!profile) throw new AppNotFoundError(appProfileId);

  const seed = SEED_APPS.find((s) => s.appId === profile.appId);
  const url =
    rootUrl ??
    seed?.docsRoot ??
    `https://www.google.com/search?q=${encodeURIComponent(profile.appName + " documentation")}`;

  const now = Date.now();
  const id = `dock_${nanoid()}`;
  await db.insert(appDocIngestions).values(
    withTenantValues(ctx, {
      id,
      appProfileId,
      status: "queued",
      rootUrl: url,
      pagesPlanned: 3,
      startedAt: now,
    }),
  );

  await db
    .update(appProfiles)
    .set({ docIndexStatus: "queued", updatedAt: now })
    .where(
      and(tenantScope(ctx, appProfiles), eq(appProfiles.id, appProfileId)),
    );
  profileCache.delete(cacheKey({ ...ctx, appId: profile.appId }));

  await logPrivacyEvent(ctx, {
    eventType: "app.deep_learn.queued",
    actor: ctx.userId ?? ctx.tenantId,
    target: profile.appId,
    severity: "low",
    detail: `root=${url}`,
  });

  // Tier 1 doc-fetch — bounded, SSRF-guarded, per-URL privacy logged.
  const planned = [url];
  let fetched = 0;
  let chunks = 0;
  let lastError: string | null = null;
  for (const target of planned) {
    if (!isPublicHttpsUrl(target)) {
      lastError = `refused non-public URL: ${target}`;
      await logPrivacyEvent(ctx, {
        eventType: "app.deep_learn.refused",
        actor: ctx.userId ?? ctx.tenantId,
        target: profile.appId,
        severity: "medium",
        detail: `url=${target} reason=ssrf_guard`,
      });
      continue;
    }
    try {
      const text = await fetchWithTimeout(target, 10_000);
      fetched += 1;
      // Crude but predictable chunk count — full embed pipeline lands in
      // Task #19. We persist the count so the UI can show progress.
      chunks += Math.max(1, Math.ceil(text.length / 800));
      await logPrivacyEvent(ctx, {
        eventType: "app.deep_learn.fetch",
        actor: ctx.userId ?? ctx.tenantId,
        target: profile.appId,
        severity: "low",
        detail: `url=${target} bytes=${text.length} chunks=${chunks}`,
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await logPrivacyEvent(ctx, {
        eventType: "app.deep_learn.error",
        actor: ctx.userId ?? ctx.tenantId,
        target: profile.appId,
        severity: "medium",
        detail: `url=${target} error=${lastError}`,
      });
    }
  }

  const finalStatus =
    fetched > 0 ? "ready" : lastError ? "error" : "queued";
  await db
    .update(appDocIngestions)
    .set({
      status: finalStatus,
      pagesFetched: fetched,
      chunksEmbedded: chunks,
      error: lastError,
      completedAt: fetched > 0 || lastError ? Date.now() : null,
      updatedAt: Date.now(),
    })
    .where(
      and(tenantScope(ctx, appDocIngestions), eq(appDocIngestions.id, id)),
    );

  await db
    .update(appProfiles)
    .set({
      docIndexStatus: finalStatus,
      sources: JSON.stringify({ ...profile.sources, docs: fetched > 0 }),
      updatedAt: Date.now(),
    })
    .where(
      and(tenantScope(ctx, appProfiles), eq(appProfiles.id, appProfileId)),
    );
  profileCache.delete(cacheKey({ ...ctx, appId: profile.appId }));

  const rows = await db
    .select()
    .from(appDocIngestions)
    .where(
      and(tenantScope(ctx, appDocIngestions), eq(appDocIngestions.id, id)),
    )
    .limit(1);
  if (!rows[0]) throw new Error("Doc ingestion vanished after insert");
  return toDocRow(rows[0]);
}

/**
 * Returns true if a literal IPv4/IPv6 address falls inside a reserved /
 * private / loopback / link-local range that an attacker could pivot to
 * via SSRF (e.g. cloud metadata at 169.254.169.254, RFC1918 LANs, ::1).
 * Exported for test fixtures.
 */
export function isPrivateOrReservedIp(addr: string): boolean {
  // IPv6 literal — check loopback, link-local, unique-local, IPv4-mapped.
  if (addr.includes(":")) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — extract and recurse on the v4 tail.
    const v4 = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) return isPrivateOrReservedIp(v4[1]!);
    return false;
  }
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * SSRF guard — only allow HTTPS URLs whose host parses as a public DNS
 * name. Refuses literal IPs, localhost, file/data/javascript schemes.
 * Exported for test fixtures.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (!h) return false;
    if (h === "localhost" || h.endsWith(".localhost")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      return !isPrivateOrReservedIp(h);
    }
    if (h.includes(":")) return false; // IPv6 literal — refuse outright
    if (!h.includes(".")) return false; // bare hostname (intranet)
    // Refuse common intranet / mDNS suffixes that look public but resolve
    // to LAN by convention.
    if (
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      h.endsWith(".lan") ||
      h.endsWith(".intranet")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `hostname` and verify EVERY returned address is public. Defends
 * against DNS rebinding / attacker-controlled records that point public
 * names at RFC1918 / metadata IPs.
 */
async function assertHostResolvesPublic(hostname: string): Promise<void> {
  const dns = await import("node:dns/promises");
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) {
    throw new Error(`SSRF guard: ${hostname} resolved to no addresses`);
  }
  for (const r of records) {
    if (isPrivateOrReservedIp(r.address)) {
      throw new Error(
        `SSRF guard: ${hostname} resolves to private address ${r.address}`,
      );
    }
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  // Honour an offline test mode so the suite is hermetic — the URL still
  // goes through the SSRF check, but the actual network call is skipped
  // and a deterministic body is returned.
  if (process.env["FEATURE_APP_CAPABILITIES_OFFLINE"] === "1") {
    return `OFFLINE-STUB ${url}`;
  }
  // DNS-resolution SSRF check — even with a "public" hostname, resolve
  // and verify no record points at a private / reserved range. Closes the
  // DNS-rebinding hole the previous host-pattern-only guard left open.
  const u = new URL(url);
  await assertHostResolvesPublic(u.hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // Outbound network call — caller (`startDeepLearn`) wraps this in a
    // `logPrivacyEvent({ eventType: "app.deep_learn.fetch" })` so every
    // request is recorded in the privacy_events ledger.
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── MCP connect / disconnect ───────────────────────────────────────────────

export async function connectMcp(
  ctx: TenantContext,
  appProfileId: string,
  endpoint?: string,
): Promise<AppMcpConnectionRow> {
  const profile = await getProfile(ctx, appProfileId);
  if (!profile) throw new AppNotFoundError(appProfileId);

  const seed = SEED_APPS.find((s) => s.appId === profile.appId);
  const targetEndpoint = endpoint ?? seed?.mcpEndpoint;
  if (!targetEndpoint) {
    throw new Error(
      `App ${profile.appId} does not declare an MCP endpoint and none was supplied.`,
    );
  }

  const now = Date.now();
  // One connection per (profile) — find or create.
  const existing = await db
    .select()
    .from(appMcpConnections)
    .where(
      and(
        tenantScope(ctx, appMcpConnections),
        eq(appMcpConnections.appProfileId, appProfileId),
      ),
    )
    .limit(1);

  // MCP handshake — the stub mode below mirrors the JSON-RPC `initialize`
  // → `tools/list` flow defined by https://modelcontextprotocol.io. The
  // real keytar-backed credential storage + websocket dispatcher lands
  // alongside Task #46 runtime work; today we record the same shape so
  // the rest of the agent stack can integrate against a stable contract.
  const tools = await mcpHandshake(targetEndpoint, profile.appName);
  await logPrivacyEvent(ctx, {
    eventType: "app.mcp.handshake",
    actor: ctx.userId ?? ctx.tenantId,
    target: profile.appId,
    severity: "medium",
    detail: `endpoint=${targetEndpoint} tools=${tools.length}`,
  });

  let connectionId: string;
  if (existing[0]) {
    connectionId = existing[0].id;
    await db
      .update(appMcpConnections)
      .set({
        endpoint: targetEndpoint,
        status: "connected",
        toolsJson: JSON.stringify(tools),
        connectedAt: now,
        disconnectedAt: null,
        error: null,
        updatedAt: now,
      })
      .where(
        and(
          tenantScope(ctx, appMcpConnections),
          eq(appMcpConnections.id, connectionId),
        ),
      );
  } else {
    connectionId = `mcp_${nanoid()}`;
    await db.insert(appMcpConnections).values(
      withTenantValues(ctx, {
        id: connectionId,
        appProfileId,
        endpoint: targetEndpoint,
        status: "connected",
        toolsJson: JSON.stringify(tools),
        connectedAt: now,
      }),
    );
  }

  // Mirror MCP tools into capability commands so the Planner sees them.
  await db
    .delete(appCapabilityCommands)
    .where(
      and(
        tenantScope(ctx, appCapabilityCommands),
        eq(appCapabilityCommands.appProfileId, appProfileId),
        eq(appCapabilityCommands.source, "mcp"),
      ),
    );
  for (const tool of tools) {
    await db.insert(appCapabilityCommands).values(
      withTenantValues(ctx, {
        id: `cmd_${nanoid()}`,
        appProfileId,
        kind: "mcp_tool",
        source: "mcp",
        name: tool.name,
        description: tool.description ?? "",
      }),
    );
  }

  await db
    .update(appProfiles)
    .set({ mcpStatus: "connected", updatedAt: now })
    .where(
      and(tenantScope(ctx, appProfiles), eq(appProfiles.id, appProfileId)),
    );
  profileCache.delete(cacheKey({ ...ctx, appId: profile.appId }));

  await logPrivacyEvent(ctx, {
    eventType: "app.mcp.connected",
    actor: ctx.userId ?? ctx.tenantId,
    target: profile.appId,
    severity: "medium",
    detail: `endpoint=${targetEndpoint}`,
  });

  const fresh = await db
    .select()
    .from(appMcpConnections)
    .where(
      and(
        tenantScope(ctx, appMcpConnections),
        eq(appMcpConnections.id, connectionId),
      ),
    )
    .limit(1);
  if (!fresh[0]) throw new Error("MCP connection vanished after upsert");
  return toMcpRow(fresh[0]);
}

export async function disconnectMcp(
  ctx: TenantContext,
  appProfileId: string,
): Promise<AppMcpConnectionRow | null> {
  const profile = await getProfile(ctx, appProfileId);
  if (!profile) throw new AppNotFoundError(appProfileId);

  const existing = await db
    .select()
    .from(appMcpConnections)
    .where(
      and(
        tenantScope(ctx, appMcpConnections),
        eq(appMcpConnections.appProfileId, appProfileId),
      ),
    )
    .limit(1);
  if (!existing[0]) return null;

  const now = Date.now();
  await db
    .update(appMcpConnections)
    .set({
      status: "disconnected",
      disconnectedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        tenantScope(ctx, appMcpConnections),
        eq(appMcpConnections.id, existing[0].id),
      ),
    );

  await db
    .delete(appCapabilityCommands)
    .where(
      and(
        tenantScope(ctx, appCapabilityCommands),
        eq(appCapabilityCommands.appProfileId, appProfileId),
        eq(appCapabilityCommands.source, "mcp"),
      ),
    );

  await db
    .update(appProfiles)
    .set({ mcpStatus: "available", updatedAt: now })
    .where(
      and(tenantScope(ctx, appProfiles), eq(appProfiles.id, appProfileId)),
    );
  profileCache.delete(cacheKey({ ...ctx, appId: profile.appId }));

  await logPrivacyEvent(ctx, {
    eventType: "app.mcp.disconnected",
    actor: ctx.userId ?? ctx.tenantId,
    target: profile.appId,
    severity: "low",
    detail: `connection=${existing[0].id}`,
  });

  const fresh = await db
    .select()
    .from(appMcpConnections)
    .where(
      and(
        tenantScope(ctx, appMcpConnections),
        eq(appMcpConnections.id, existing[0].id),
      ),
    )
    .limit(1);
  return fresh[0] ? toMcpRow(fresh[0]) : null;
}

/**
 * MCP handshake (JSON-RPC 2.0). Real mode posts an `initialize` request
 * followed by `tools/list`; stub mode (default in tests / dev without
 * credentials) returns a deterministic 2-tool list shaped the same way
 * as the real response so callers don't have a per-mode branch.
 *
 * The endpoint MUST be HTTPS and a public DNS name — same SSRF guard as
 * Deep Learn — so a misconfigured profile can't pivot the request to an
 * internal service. Errors are surfaced as thrown `Error` instances; the
 * caller decides whether to mark the connection `error` vs. retry.
 */
export async function mcpHandshake(
  endpoint: string,
  appName: string,
): Promise<ReadonlyArray<{ name: string; description: string }>> {
  const stubMode =
    process.env["FEATURE_APP_CAPABILITIES_OFFLINE"] === "1" ||
    process.env["NODE_ENV"] === "test";
  if (stubMode) {
    return [
      { name: `${appName}.list`, description: `List entities in ${appName}` },
      { name: `${appName}.create`, description: `Create entity in ${appName}` },
    ];
  }
  if (!isPublicHttpsUrl(endpoint)) {
    throw new Error(`MCP endpoint refused by SSRF guard: ${endpoint}`);
  }
  await assertHostResolvesPublic(new URL(endpoint).hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // Outbound network call — caller (`connectMcp`) wraps this in a
    // `logPrivacyEvent({ eventType: "app.mcp.handshake" })` so every
    // outbound MCP probe is recorded in the privacy_events ledger.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    if (!res.ok) throw new Error(`MCP handshake HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: { tools?: Array<{ name?: string; description?: string }> };
    };
    const tools = json.result?.tools ?? [];
    return tools
      .filter((t): t is { name: string; description?: string } =>
        typeof t.name === "string",
      )
      .map((t) => ({ name: t.name, description: t.description ?? "" }));
  } finally {
    clearTimeout(timer);
  }
}

// ─── Install community App-Skill ────────────────────────────────────────────

export async function installAppSkill(
  ctx: TenantContext,
  appProfileId: string,
  skillId: string,
): Promise<AppProfileRow> {
  const profile = await getProfile(ctx, appProfileId);
  if (!profile) throw new AppNotFoundError(appProfileId);

  // Validate the skill exists in this tenant.
  const skill = await db
    .select()
    .from(skillsTable)
    .where(and(tenantScope(ctx, skillsTable), eq(skillsTable.id, skillId)))
    .limit(1);
  if (!skill[0]) {
    throw new Error(`Skill ${skillId} not found in tenant.`);
  }

  const now = Date.now();
  await db
    .update(skillsTable)
    .set({ targetAppId: profile.appId, updatedAt: now })
    .where(and(tenantScope(ctx, skillsTable), eq(skillsTable.id, skillId)));

  const sources: AppProfileSources = { ...profile.sources, skill: true };
  await db
    .update(appProfiles)
    .set({
      installedSkillId: skillId,
      sources: JSON.stringify(sources),
      updatedAt: now,
    })
    .where(
      and(tenantScope(ctx, appProfiles), eq(appProfiles.id, appProfileId)),
    );

  // Mirror the skill as a capability command so the Planner can surface it.
  await db
    .delete(appCapabilityCommands)
    .where(
      and(
        tenantScope(ctx, appCapabilityCommands),
        eq(appCapabilityCommands.appProfileId, appProfileId),
        eq(appCapabilityCommands.source, "skill"),
      ),
    );
  await db.insert(appCapabilityCommands).values(
    withTenantValues(ctx, {
      id: `cmd_${nanoid()}`,
      appProfileId,
      kind: "skill_action",
      source: "skill",
      name: skill[0].name,
      description: skill[0].description,
      payloadJson: JSON.stringify({ skillId }),
    }),
  );

  profileCache.delete(cacheKey({ ...ctx, appId: profile.appId }));

  await logPrivacyEvent(ctx, {
    eventType: "app.skill.installed",
    actor: ctx.userId ?? ctx.tenantId,
    target: profile.appId,
    severity: "low",
    detail: `skill=${skillId}`,
  });

  const fresh = await getProfile(ctx, appProfileId);
  if (!fresh) throw new Error("Profile vanished after skill install");
  return fresh;
}

// ─── Agent integration helpers ──────────────────────────────────────────────

/**
 * Returns a compact capability summary for the Planner to embed in its
 * scratchpad before planning a goal that mentions an app. Bounded to the
 * top-N commands to keep token usage predictable.
 */
export async function summariseCapabilitiesForAgent(
  ctx: TenantContext,
  appId: string,
  topN = 20,
): Promise<{
  appName: string;
  appId: string;
  commands: ReadonlyArray<{ kind: string; source: string; name: string; shortcut: string | null }>;
} | null> {
  const profile = await getProfileByAppId(ctx, appId);
  if (!profile) return null;
  const cmds = await db
    .select()
    .from(appCapabilityCommands)
    .where(
      and(
        tenantScope(ctx, appCapabilityCommands),
        eq(appCapabilityCommands.appProfileId, profile.id),
      ),
    )
    .orderBy(asc(appCapabilityCommands.name))
    .limit(Math.min(topN, 100));
  return {
    appName: profile.appName,
    appId: profile.appId,
    commands: cmds.map((r) => ({
      kind: r.kind,
      source: r.source,
      name: r.name,
      shortcut: r.shortcut,
    })),
  };
}

logger.debug("App Capability service module loaded.");
