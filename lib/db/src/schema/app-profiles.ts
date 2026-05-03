/**
 * `app_profiles` — per-application capability profile (Task #70).
 *
 * One row per (tenant, workspace, app slug). The Universal App
 * Understanding indexer fuses four sources into a single profile:
 *
 *   - OS-native introspection (.sdef on macOS, UIA on Windows,
 *     `.desktop` + AT-SPI on Linux, plus the menu bar / shortcuts).
 *   - Public documentation ingested into the local vector store.
 *   - MCP (Model Context Protocol) connector when the app ships one.
 *   - Community App Skills installed from the marketplace.
 *
 * The agent layer (Router / Planner / Desktop Control) reads this row
 * (and the related `app_capability_commands`) before falling back to
 * pure-vision planning. `lastRefreshedAt` + `profileTtlMs` drive the
 * background re-derivation when an app version changes.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { skills } from "./skills";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const appProfiles = sqliteTable(
  "app_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Stable slug, e.g. "com.apple.finalcutpro" or "code". */
    appId: text("app_id").notNull(),
    appName: text("app_name").notNull(),
    appVersion: text("app_version").notNull().default("0.0.0"),
    /** "macos" | "windows" | "linux". */
    platform: text("platform").notNull().default("macos"),
    /**
     * JSON-encoded capability source flags:
     *   { osNative: bool, mcp: bool, docs: bool, skill: bool }
     */
    sources: text("sources").notNull().default('{"osNative":false,"mcp":false,"docs":false,"skill":false}'),
    commandCount: integer("command_count").notNull().default(0),
    menuCount: integer("menu_count").notNull().default(0),
    shortcutCount: integer("shortcut_count").notNull().default(0),
    /** "absent" | "queued" | "indexing" | "ready" | "failed". */
    docIndexStatus: text("doc_index_status").notNull().default("absent"),
    /** "absent" | "available" | "connected" | "error". */
    mcpStatus: text("mcp_status").notNull().default("absent"),
    /** Optional skill row representing the installed App Skill. */
    installedSkillId: text("installed_skill_id").references(() => skills.id),
    /** Last successful re-derivation (epoch ms). */
    lastRefreshedAt: integer("last_refreshed_at"),
    /** Cache TTL — re-derivation runs once this elapses or app version changes. */
    profileTtlMs: integer("profile_ttl_ms").notNull().default(86_400_000),
    /** Optional path on disk where the .sdef / .desktop file was found. */
    discoveredPath: text("discovered_path"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_app_profiles_tenant").on(t.tenantId),
    workspaceIdx: index("idx_app_profiles_workspace").on(t.workspaceId),
    appIdx: index("idx_app_profiles_app").on(t.tenantId, t.appId),
    skillIdx: index("idx_app_profiles_skill").on(t.installedSkillId),
    refreshedIdx: index("idx_app_profiles_refreshed").on(t.tenantId, t.lastRefreshedAt),
  }),
);

export type AppProfile = typeof appProfiles.$inferSelect;
export type NewAppProfile = typeof appProfiles.$inferInsert;
