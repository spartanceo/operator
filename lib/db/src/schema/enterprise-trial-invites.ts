/**
 * `enterprise_trial_invites` — colleague invites that trigger an
 * enterprise trial offer ("OP for Teams" referral).
 *
 * The user enters a colleague's work email; the row is persisted and a
 * trial-offer email is queued. Status transitions: `pending` → `accepted`
 * | `declined` | `expired`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const enterpriseTrialInvites = sqliteTable(
  "enterprise_trial_invites",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    colleagueEmail: text("colleague_email").notNull(),
    colleagueName: text("colleague_name"),
    company: text("company"),
    note: text("note"),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_enterprise_trial_invites_tenant").on(t.tenantId),
    statusIdx: index("idx_enterprise_trial_invites_status").on(t.tenantId, t.status),
    emailIdx: index("idx_enterprise_trial_invites_email").on(t.colleagueEmail),
  }),
);

export type EnterpriseTrialInvite = typeof enterpriseTrialInvites.$inferSelect;
export type NewEnterpriseTrialInvite = typeof enterpriseTrialInvites.$inferInsert;
