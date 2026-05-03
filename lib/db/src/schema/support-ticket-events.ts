/**
 * `support_ticket_events` — append-only conversation log on a support ticket.
 *
 * Each row is one message sent by either the user (`sender = 'user'`) or
 * an OP team member (`sender = 'op'`), plus internal notes
 * (`sender = 'system'`) emitted by the priority-routing engine.
 *
 * Append-only — no `version` column (audit-class table per Standard 6).
 * The "event" keyword in the table name matches the tier-review append-only
 * carve-out.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { supportTickets } from "./support-tickets";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const supportTicketEvents = sqliteTable(
  "support_ticket_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    ticketId: text("ticket_id").notNull().references(() => supportTickets.id),
    /** user | op | system */
    sender: text("sender").notNull().default("user"),
    senderLabel: text("sender_label").notNull().default(""),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_support_ticket_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_support_ticket_events_workspace").on(t.workspaceId),
    ticketIdx: index("idx_support_ticket_events_ticket").on(t.ticketId),
  }),
);

export type SupportTicketEvent = typeof supportTicketEvents.$inferSelect;
export type NewSupportTicketEvent = typeof supportTicketEvents.$inferInsert;
