/**
 * `outreach_sequences` — multi-step email outreach campaigns.
 *
 * Each sequence carries an ordered list of steps inline (`stepsJson`) so the
 * sequence runner doesn't fan out into a second table for the v1 cut. A
 * step is `{ subject, body, delayDays }`. Reply-stop is enforced by the
 * runner — when an enrolment receives a reply, the runner advances the
 * `status` to `replied` and skips remaining steps.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { commAccounts } from "./comm-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const outreachSequences = sqliteTable(
  "outreach_sequences",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => commAccounts.id),
    name: text("name").notNull(),
    description: text("description"),
    /** JSON: `[{ subject, body, delayDays }]` — ordered. */
    stepsJson: text("steps_json").notNull(),
    /** "active" | "paused" | "archived". */
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_outreach_sequences_tenant").on(t.tenantId),
    workspaceIdx: index("idx_outreach_sequences_workspace").on(t.workspaceId),
    accountIdx: index("idx_outreach_sequences_account").on(t.accountId),
    statusIdx: index("idx_outreach_sequences_status").on(t.tenantId, t.status),
  }),
);

export type OutreachSequence = typeof outreachSequences.$inferSelect;
export type NewOutreachSequence = typeof outreachSequences.$inferInsert;
