/**
 * `referral_rewards` — granted reward rows.
 *
 * Each completed referral grants a reward to BOTH the referrer and the
 * referred user (dual-reward). The current reward is 30 days of curated
 * premium-skill access. Rows are append-only — the redemption surface
 * computes "active" rewards as those whose `expiresAt > now`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const referralRewards = sqliteTable(
  "referral_rewards",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    referralId: text("referral_id"),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    grantedAt: integer("granted_at").notNull().default(sql`(unixepoch() * 1000)`),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_referral_rewards_tenant").on(t.tenantId),
    expiresIdx: index("idx_referral_rewards_expires").on(t.tenantId, t.expiresAt),
  }),
);

export type ReferralReward = typeof referralRewards.$inferSelect;
export type NewReferralReward = typeof referralRewards.$inferInsert;
