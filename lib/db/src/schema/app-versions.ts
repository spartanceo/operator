/**
 * `app_versions` — desktop release channel + force-update floor.
 *
 * The Super Admin dashboard publishes release rows here. Exactly one row
 * per channel may carry `is_current = 1`; the desktop updater queries it
 * via `/admin/super/version/current`. Setting `is_min_required = 1`
 * marks the version as the absolute minimum — older clients are forced
 * to update on next launch (used for critical security patches).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const appVersions = sqliteTable(
  "app_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    versionString: text("version_string").notNull(),
    channel: text("channel").notNull().default("stable"),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
    isMinRequired: integer("is_min_required", { mode: "boolean" })
      .notNull()
      .default(false),
    notes: text("notes").notNull().default(""),
    releasedAt: integer("released_at").notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_app_versions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_app_versions_workspace").on(t.workspaceId),
    channelIdx: index("idx_app_versions_channel").on(t.channel),
    versionIdx: uniqueIndex("uq_app_versions_string").on(t.versionString),
  }),
);

export type AppVersion = typeof appVersions.$inferSelect;
export type NewAppVersion = typeof appVersions.$inferInsert;
