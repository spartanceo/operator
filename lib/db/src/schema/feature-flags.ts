/**
 * `feature_flags` — global remote-config toggles.
 *
 * Used by the Super Admin dashboard to flip features on/off without
 * shipping a new desktop build. The unique key is `flag_key`; the row
 * is owned by the system tenant + workspace because flags apply
 * platform-wide. Optional `segment` lets us target a subset (e.g.
 * `beta`, `enterprise`) and `rollout_percent` enables gradual rollouts.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const featureFlags = sqliteTable(
  "feature_flags",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    flagKey: text("flag_key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    segment: text("segment").notNull().default("all"),
    description: text("description").notNull().default(""),
    rolloutPercent: integer("rollout_percent").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_feature_flags_tenant").on(t.tenantId),
    workspaceIdx: index("idx_feature_flags_workspace").on(t.workspaceId),
    keyIdx: uniqueIndex("uq_feature_flags_key").on(t.flagKey),
  }),
);

export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;
