/**
 * `email_messages` — local mirror of inbox + sent mail.
 *
 * Mail is fetched from Gmail / Outlook via OAuth and cached here so OP can
 * read, summarise, categorise, and triage without hitting the provider on
 * every request. The `direction` discriminator separates `inbound` from
 * `outbound`. `threadId` links replies in the same conversation.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { commAccounts } from "./comm-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const emailMessages = sqliteTable(
  "email_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => commAccounts.id),
    /** Provider message id (Gmail rfc822 id / Outlook id). */
    providerMessageId: text("provider_message_id"),
    /** Provider-side conversation id used to thread replies. */
    threadId: text("thread_id"),
    /** "inbound" | "outbound". */
    direction: text("direction").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddresses: text("to_addresses").notNull(),
    subject: text("subject").notNull(),
    snippet: text("snippet").notNull(),
    body: text("body").notNull(),
    /** "inbox" | "sent" | "archived" | "spam" | "trash". */
    folder: text("folder").notNull().default("inbox"),
    /** "unread" | "read" | "replied" | "archived". */
    status: text("status").notNull().default("unread"),
    /** AI-assigned category — "work" / "personal" / "promo" / etc. */
    category: text("category"),
    receivedAt: integer("received_at").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_email_messages_tenant").on(t.tenantId),
    workspaceIdx: index("idx_email_messages_workspace").on(t.workspaceId),
    accountIdx: index("idx_email_messages_account").on(t.accountId),
    threadIdx: index("idx_email_messages_thread").on(t.tenantId, t.threadId),
    folderIdx: index("idx_email_messages_folder").on(t.tenantId, t.folder),
    receivedIdx: index("idx_email_messages_received").on(t.tenantId, t.receivedAt),
  }),
);

export type EmailMessage = typeof emailMessages.$inferSelect;
export type NewEmailMessage = typeof emailMessages.$inferInsert;
