/**
 * `creator_payout_screenings` — append-only sanctions-list screening
 * results. Each payout request is checked against OFAC SDN, OFAC
 * consolidated, UK HMT, and EU consolidated lists. A single `hit` row
 * blocks payouts until manual review clears it.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { creatorAccounts } from "./creator-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const creatorPayoutScreenings = sqliteTable(
  "creator_payout_screenings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    creatorId: text("creator_id").notNull().references(() => creatorAccounts.id),
    listName: text("list_name").notNull(),
    result: text("result").notNull(),
    matchedName: text("matched_name"),
    matchedCountry: text("matched_country"),
    notes: text("notes"),
    screenedAt: integer("screened_at").notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_creator_payout_screen_tenant").on(t.tenantId),
    workspaceIdx: index("idx_creator_payout_screen_workspace").on(t.workspaceId),
    creatorIdx: index("idx_creator_payout_screen_creator").on(t.creatorId, t.screenedAt),
    resultIdx: index("idx_creator_payout_screen_result").on(t.result, t.screenedAt),
  }),
);

export type CreatorPayoutScreening = typeof creatorPayoutScreenings.$inferSelect;
export type NewCreatorPayoutScreening = typeof creatorPayoutScreenings.$inferInsert;
