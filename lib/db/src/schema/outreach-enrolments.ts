/**
 * `outreach_enrolments` — one row per (sequence, contact) pairing.
 *
 * Tracks which step the contact is currently on, when the next send is due,
 * and the terminal state when the sequence ends. Reply-stop is the canonical
 * exit: when the runner sees an inbound reply on the threaded conversation
 * it sets `status = 'replied'` and stops sending.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { contacts } from "./contacts";
import { outreachSequences } from "./outreach-sequences";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const outreachEnrolments = sqliteTable(
  "outreach_enrolments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    sequenceId: text("sequence_id").notNull().references(() => outreachSequences.id),
    contactId: text("contact_id").notNull().references(() => contacts.id),
    /** "active" | "completed" | "replied" | "paused" | "stopped". */
    status: text("status").notNull().default("active"),
    /** Zero-based index into the sequence's steps array. */
    currentStep: integer("current_step").notNull().default(0),
    /** Unix-ms when the next step is due to send. */
    nextSendAt: integer("next_send_at"),
    /** Unix-ms when the most recent step actually went out. */
    lastSentAt: integer("last_sent_at"),
    /** Unix-ms when an inbound reply was first observed (reply-stop). */
    repliedAt: integer("replied_at"),
    /** Provider thread id used to detect replies. */
    threadId: text("thread_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_outreach_enrolments_tenant").on(t.tenantId),
    workspaceIdx: index("idx_outreach_enrolments_workspace").on(t.workspaceId),
    sequenceIdx: index("idx_outreach_enrolments_sequence").on(t.sequenceId),
    contactIdx: index("idx_outreach_enrolments_contact").on(t.contactId),
    statusIdx: index("idx_outreach_enrolments_status").on(t.tenantId, t.status),
    nextSendIdx: index("idx_outreach_enrolments_next_send").on(t.tenantId, t.nextSendAt),
  }),
);

export type OutreachEnrolment = typeof outreachEnrolments.$inferSelect;
export type NewOutreachEnrolment = typeof outreachEnrolments.$inferInsert;
