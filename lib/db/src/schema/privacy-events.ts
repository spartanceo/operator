/**
 * `privacy_events` — append-only audit log for any data egress, network call,
 * or sensitive read. Standard 12 + Section 13 of the project context: every
 * outbound fetch and every cross-boundary read MUST emit a row here so the
 * user can audit "what left my machine, when, why".
 *
 * Append-only: no version column needed; the tier-review check exempts
 * tables containing "event" from the version requirement.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const privacyEvents = sqliteTable(
  "privacy_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    target: text("target").notNull(),
    severity: text("severity").notNull().default("info"),
    detail: text("detail"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_privacy_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_privacy_events_workspace").on(t.workspaceId),
    typeIdx: index("idx_privacy_events_type").on(t.tenantId, t.eventType),
    createdIdx: index("idx_privacy_events_created").on(t.tenantId, t.createdAt),
  }),
);

export type PrivacyEvent = typeof privacyEvents.$inferSelect;
export type NewPrivacyEvent = typeof privacyEvents.$inferInsert;
