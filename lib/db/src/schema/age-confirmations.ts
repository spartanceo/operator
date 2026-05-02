/**
 * `age_confirmations` — singleton-per-tenant age-gate verdict captured
 * at account creation. COPPA (US, 13+) and GDPR-K (EU, 16+) require
 * platforms to verify users meet a minimum age before collecting any
 * personal data; this table records the user's self-declaration so the
 * gate is not re-shown on every launch.
 *
 * Mutable record — `version` is present for optimistic concurrency in
 * case the user later updates their jurisdiction (which can change the
 * minimum age threshold).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const ageConfirmations = sqliteTable(
  "age_confirmations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id"),
    jurisdiction: text("jurisdiction").notNull().default("global"),
    minimumAge: integer("minimum_age").notNull(),
    confirmed: integer("confirmed").notNull().default(0),
    confirmedAt: integer("confirmed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_age_confirmations_tenant").on(t.tenantId),
    workspaceIdx: index("idx_age_confirmations_workspace").on(t.workspaceId),
  }),
);

export type AgeConfirmation = typeof ageConfirmations.$inferSelect;
export type NewAgeConfirmation = typeof ageConfirmations.$inferInsert;
