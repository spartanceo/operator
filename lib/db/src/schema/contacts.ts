/**
 * `contacts` — local CRM contact records.
 *
 * The CRM layer auto-logs every email thread, call, and calendar
 * interaction to a contact. Lookup is by email address or phone number;
 * the service layer creates a contact on the fly the first time an
 * unknown sender appears.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    displayName: text("display_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    notes: text("notes"),
    /** Unix-ms of the most recent interaction across any channel. */
    lastInteractionAt: integer("last_interaction_at"),
    /** Unix-ms when the next follow-up is suggested by the CRM engine. */
    followUpAt: integer("follow_up_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_contacts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_contacts_workspace").on(t.workspaceId),
    emailIdx: index("idx_contacts_email").on(t.tenantId, t.email),
    phoneIdx: index("idx_contacts_phone").on(t.tenantId, t.phone),
    followUpIdx: index("idx_contacts_follow_up").on(t.tenantId, t.followUpAt),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
