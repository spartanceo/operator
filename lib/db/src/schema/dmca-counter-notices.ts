/**
 * `dmca_counter_notices` — creator counter-notices attached to a
 * takedown. Append-only ledger; once submitted the original record is
 * immutable. Status transitions to `forwarded` / `resolved` are
 * captured as separate `activity_events`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { creatorAccounts } from "./creator-accounts";
import { dmcaTakedowns } from "./dmca-takedowns";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const dmcaCounterNotices = sqliteTable(
  "dmca_counter_notices",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    takedownId: text("takedown_id").notNull().references(() => dmcaTakedowns.id),
    creatorId: text("creator_id").references(() => creatorAccounts.id),
    creatorName: text("creator_name").notNull(),
    creatorEmail: text("creator_email").notNull(),
    creatorAddress: text("creator_address").notNull(),
    statement: text("statement").notNull(),
    consentToJurisdiction: integer("consent_to_jurisdiction").notNull().default(0),
    perjuryStatement: integer("perjury_statement").notNull().default(0),
    signature: text("signature").notNull(),
    status: text("status").notNull().default("received"),
    submitterIp: text("submitter_ip"),
    submitterUserAgent: text("submitter_user_agent"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_dmca_counter_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dmca_counter_workspace").on(t.workspaceId),
    takedownIdx: index("idx_dmca_counter_takedown").on(t.takedownId),
    creatorIdx: index("idx_dmca_counter_creator").on(t.creatorId),
  }),
);

export type DmcaCounterNotice = typeof dmcaCounterNotices.$inferSelect;
export type NewDmcaCounterNotice = typeof dmcaCounterNotices.$inferInsert;
