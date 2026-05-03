/**
 * `waitlist_signups` — append-only email captures for unreleased features.
 *
 * Powers the public marketing-site waitlist page. Stored under the
 * SYSTEM tenant (rows aren't owned by a real user account — the public
 * marketing visitor has none). The unique index on `(feature, email)`
 * keeps double-submissions from spamming the table.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const waitlistSignups = sqliteTable(
  "waitlist_signups",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    feature: text("feature").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    source: text("source"),
    referralCode: text("referral_code"),
    notifiedAt: integer("notified_at"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_waitlist_signups_tenant").on(t.tenantId),
    featureIdx: index("idx_waitlist_signups_feature").on(t.feature),
    uniqueIdx: uniqueIndex("idx_waitlist_signups_unique").on(t.feature, t.email),
  }),
);

export type WaitlistSignup = typeof waitlistSignups.$inferSelect;
export type NewWaitlistSignup = typeof waitlistSignups.$inferInsert;
