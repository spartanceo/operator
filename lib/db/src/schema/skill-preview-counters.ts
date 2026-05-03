/**
 * `skill_preview_counters` — per-(tenant, skill) free-preview tally.
 *
 * The product rule is "two free uses per premium skill, then a paywall".
 * Counters increment on every preview invocation; the agent orchestrator
 * compares against `previewUsesAllowed` from the skill row before
 * granting access.
 *
 * Unique on (tenant, skill) so an insert with `INSERT OR IGNORE` is safe
 * before the read-modify-write update path.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillPreviewCounters = sqliteTable(
  "skill_preview_counters",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    skillId: text("skill_id").notNull(),
    usesConsumed: integer("uses_consumed").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_preview_counters_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_preview_counters_workspace").on(t.workspaceId),
    pairIdx: uniqueIndex("uq_skill_preview_counters_pair").on(t.tenantId, t.skillId),
  }),
);

export type SkillPreviewCounter = typeof skillPreviewCounters.$inferSelect;
export type NewSkillPreviewCounter = typeof skillPreviewCounters.$inferInsert;
