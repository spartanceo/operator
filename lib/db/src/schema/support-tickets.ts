/**
 * `support_tickets` — user-submitted help requests, bug reports, and
 * billing/account questions (Task #34).
 *
 * Mutable record (status walks `open → in_progress → resolved | closed`)
 * so the standard `version` column is required for optimistic concurrency.
 *
 * Diagnostic fields (`opVersion`, `osInfo`, `hardwareTier`) are auto-filled
 * by the in-app submission flow so the OP team can triage without
 * pestering the user. They are intentionally coarse-grained — no machine
 * IDs, no usernames, no file contents — so the row remains safe to
 * forward to a third-party support tool if needed.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const supportTickets = sqliteTable(
  "support_tickets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Email of the submitter — used for ack + reply notifications. */
    userEmail: text("user_email").notNull(),
    userLabel: text("user_label").notNull().default(""),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** general | bug | billing | account | security | feature-question | other */
    category: text("category").notNull().default("general"),
    /** low | normal | high | urgent — auto-escalated for security/billing */
    priority: text("priority").notNull().default("normal"),
    /** open | in_progress | waiting_user | resolved | closed */
    status: text("status").notNull().default("open"),
    /** OP desktop version detected at submission time. */
    opVersion: text("op_version").notNull().default(""),
    /** Coarse OS string ("macOS 14", "Windows 11", "Ubuntu 24.04"). */
    osInfo: text("os_info").notNull().default(""),
    /** Tier-1 / Tier-2 / Tier-3 hardware bucket from the resource governor. */
    hardwareTier: text("hardware_tier").notNull().default(""),
    /** Free-form note describing any attachment the user uploaded out-of-band. */
    attachmentNote: text("attachment_note").notNull().default(""),
    /** 1 when auto-escalated by priority routing rules. */
    escalated: integer("escalated").notNull().default(0),
    assigneeLabel: text("assignee_label").notNull().default(""),
    resolutionNotes: text("resolution_notes").notNull().default(""),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_support_tickets_tenant").on(t.tenantId),
    workspaceIdx: index("idx_support_tickets_workspace").on(t.workspaceId),
    statusIdx: index("idx_support_tickets_status").on(t.status),
    priorityIdx: index("idx_support_tickets_priority").on(t.priority),
    createdIdx: index("idx_support_tickets_created").on(t.createdAt),
  }),
);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;
