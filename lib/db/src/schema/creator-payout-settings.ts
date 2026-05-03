/**
 * `creator_payout_settings` — singleton-per-creator payout config.
 * Tracks payout method, jurisdiction, restriction status (sanctioned
 * / unsupported countries are forced to gift-card / account-credit),
 * and the repeat-infringer publish ban from the DMCA workflow.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { creatorAccounts } from "./creator-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const creatorPayoutSettings = sqliteTable(
  "creator_payout_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    creatorId: text("creator_id").notNull().references(() => creatorAccounts.id),
    method: text("method").notNull().default("stripe_connect"),
    currency: text("currency").notNull().default("usd"),
    minimumThresholdCents: integer("minimum_threshold_cents").notNull().default(5000),
    schedule: text("schedule").notNull().default("monthly"),
    recipientCountry: text("recipient_country").notNull(),
    restricted: integer("restricted").notNull().default(0),
    restrictionReason: text("restriction_reason"),
    lastPayoutAt: integer("last_payout_at"),
    lastPayoutCents: integer("last_payout_cents").notNull().default(0),
    publishStatus: text("publish_status").notNull().default("active"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_creator_payout_tenant").on(t.tenantId),
    workspaceIdx: index("idx_creator_payout_workspace").on(t.workspaceId),
    creatorIdx: uniqueIndex("uq_creator_payout_creator").on(t.creatorId),
  }),
);

export type CreatorPayoutSetting = typeof creatorPayoutSettings.$inferSelect;
export type NewCreatorPayoutSetting = typeof creatorPayoutSettings.$inferInsert;
