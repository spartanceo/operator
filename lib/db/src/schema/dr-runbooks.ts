/**
 * `dr_runbooks` — written disaster-recovery runbooks for every defined
 * failure scenario (Task #59 — Platform Disaster Recovery).
 *
 * The DR service seeds the canonical runbooks (primary DB failure, data
 * corruption, accidental mass deletion, region outage, replica lag) on
 * first boot from the markdown files in
 * `artifacts/api-server/src/services/dr/runbooks`. Mutable: an on-call
 * engineer can edit the markdown body via the admin UI; revisions are
 * tracked via the `version` column.
 *
 * `severityTier` mirrors the incident severity tiers — P0 (marketplace
 * down), P1 (skill downloads failing), P2 (analytics degraded). Each tier
 * has a defined `responseSlaMinutes` so the alerting policy can compute
 * the deadline at trigger time rather than hard-coding it in code.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const drRunbooks = sqliteTable(
  "dr_runbooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    scenario: text("scenario").notNull(),
    title: text("title").notNull(),
    severityTier: text("severity_tier").notNull().default("P1"),
    responseSlaMinutes: integer("response_sla_minutes").notNull().default(30),
    body: text("body").notNull(),
    lastReviewedAt: integer("last_reviewed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dr_runbooks_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dr_runbooks_workspace").on(t.workspaceId),
    scenarioIdx: uniqueIndex("uq_dr_runbooks_scenario").on(t.tenantId, t.scenario),
  }),
);

export type DrRunbook = typeof drRunbooks.$inferSelect;
export type NewDrRunbook = typeof drRunbooks.$inferInsert;
