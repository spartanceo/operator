/**
 * `interactions` — append-only contact history log.
 *
 * Every email thread, call, and calendar event auto-logs one row here so
 * the CRM can answer "what did I last discuss with John Smith?" without
 * scanning the underlying tables. The `kind` discriminator keeps the
 * vocabulary small: `email_in` / `email_out` / `call_in` / `call_out` /
 * `meeting`. `referenceId` points at the source row in the per-channel
 * table.
 *
 * Append-only: no version column needed; the tier-review version-required
 * check exempts tables containing "event" / "log" / "interaction".
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { contacts } from "./contacts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const interactions = sqliteTable(
  "interactions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    contactId: text("contact_id").notNull().references(() => contacts.id),
    kind: text("kind").notNull(),
    /** Source row id (`email_messages.id`, `voip_calls.id`, `calendar_events.id`). */
    referenceId: text("reference_id"),
    summary: text("summary").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_interactions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_interactions_workspace").on(t.workspaceId),
    contactIdx: index("idx_interactions_contact").on(t.contactId),
    occurredIdx: index("idx_interactions_occurred").on(t.tenantId, t.occurredAt),
    kindIdx: index("idx_interactions_kind").on(t.tenantId, t.kind),
  }),
);

export type Interaction = typeof interactions.$inferSelect;
export type NewInteraction = typeof interactions.$inferInsert;
