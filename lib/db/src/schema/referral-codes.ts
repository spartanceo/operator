/**
 * `referral_codes` — singleton-per-tenant referral identity.
 *
 * Every tenant gets exactly one referral code generated on first read.
 * The code is a short, URL-safe slug used in shareable links such as
 * `https://omninity.app/r/<code>`. We store the canonical short URL the
 * link service rendered so the dashboard can display the same string the
 * user copied without recomputing it.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const referralCodes = sqliteTable(
  "referral_codes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    code: text("code").notNull(),
    shareUrl: text("share_url").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_referral_codes_tenant").on(t.tenantId),
    codeIdx: index("idx_referral_codes_code").on(t.code),
  }),
);

export type ReferralCode = typeof referralCodes.$inferSelect;
export type NewReferralCode = typeof referralCodes.$inferInsert;
