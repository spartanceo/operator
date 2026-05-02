/**
 * `email_drafts` — outbound email drafts pending user approval.
 *
 * The compose path generates a draft (optionally as a reply to an existing
 * thread), captures it here, and waits for the user to approve through the
 * standard approval flow before the send tool runs. `decision` mirrors the
 * `approvals.decision` shape so handlers can switch on the same vocabulary.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { commAccounts } from "./comm-accounts";
import { emailMessages } from "./email-messages";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const emailDrafts = sqliteTable(
  "email_drafts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => commAccounts.id),
    /** Optional — set when the draft is a reply. */
    replyToMessageId: text("reply_to_message_id").references(() => emailMessages.id),
    /** Optional — set when the draft is part of an outreach sequence. */
    sequenceId: text("sequence_id"),
    enrolmentId: text("enrolment_id"),
    toAddresses: text("to_addresses").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** "pending" | "approved" | "denied" | "sent". */
    decision: text("decision").notNull().default("pending"),
    decidedAt: integer("decided_at"),
    sentAt: integer("sent_at"),
    /** Surfaced provider id once the draft is sent. */
    providerMessageId: text("provider_message_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_email_drafts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_email_drafts_workspace").on(t.workspaceId),
    accountIdx: index("idx_email_drafts_account").on(t.accountId),
    replyIdx: index("idx_email_drafts_reply_to").on(t.replyToMessageId),
    decisionIdx: index("idx_email_drafts_decision").on(t.tenantId, t.decision),
  }),
);

export type EmailDraft = typeof emailDrafts.$inferSelect;
export type NewEmailDraft = typeof emailDrafts.$inferInsert;
