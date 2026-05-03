/**
 * `beta_access_grants` — singleton-per-tenant beta-tier flag.
 *
 * Granted automatically when a tenant's completed-referral count reaches
 * `BETA_REFERRAL_THRESHOLD` (3 by default). The row is the source-of-truth
 * for the operator-side feature-gate banner; it carries the ISO timestamp
 * of activation so the UI can show "Beta unlocked on …".
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const betaAccessGrants = sqliteTable(
  "beta_access_grants",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    tier: text("tier").notNull().default("beta"),
    reason: text("reason").notNull().default("referral_threshold"),
    grantedAt: integer("granted_at").notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_beta_access_tenant").on(t.tenantId),
  }),
);

export type BetaAccessGrant = typeof betaAccessGrants.$inferSelect;
export type NewBetaAccessGrant = typeof betaAccessGrants.$inferInsert;
