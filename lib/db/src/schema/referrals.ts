/**
 * `referrals` — attribution rows recorded when a referred install completes.
 *
 * Lifecycle:
 *   - `status = 'pending'`   : link clicked, sign-up not yet completed.
 *   - `status = 'completed'` : referred user finished onboarding; both sides
 *                              earn the dual reward and the row is updated
 *                              with `completedAt` + `rewardGrantedAt`.
 *
 * Tracking is cookieless — the short referral link carries the code in its
 * path and the web client posts it back on first install (local
 * verification). No third-party trackers, no IP fingerprinting.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const referrals = sqliteTable(
  "referrals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    referrerTenantId: text("referrer_tenant_id").notNull().references(() => tenants.id),
    referredTenantId: text("referred_tenant_id").references(() => tenants.id),
    referredEmail: text("referred_email"),
    referredLabel: text("referred_label"),
    code: text("code").notNull(),
    status: text("status").notNull().default("pending"),
    completedAt: integer("completed_at"),
    rewardGrantedAt: integer("reward_granted_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_referrals_tenant").on(t.tenantId),
    referrerIdx: index("idx_referrals_referrer").on(t.referrerTenantId),
    referredIdx: index("idx_referrals_referred").on(t.referredTenantId),
    codeIdx: index("idx_referrals_code").on(t.code),
    statusIdx: index("idx_referrals_status").on(t.tenantId, t.status),
  }),
);

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
