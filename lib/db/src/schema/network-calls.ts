/**
 * `network_calls` — append-only log of every outbound network call OP makes.
 *
 * The Privacy Dashboard's "What's been shared" panel reads from this table.
 * Every service that issues a `fetch()` MUST also call
 * `recordNetworkCall(...)` so the dashboard reflects reality (Standard 12 +
 * Section 13: every cross-boundary call is auditable).
 *
 * Append-only — no `version` column required (the tier-review check exempts
 * tables containing "calls" / "events" / "log" from the version requirement).
 *
 * `initiator` is one of:
 *   - "user"       (a click-driven explicit action, e.g. fetching a model
 *                   the user just typed)
 *   - "automatic"  (a background sync / scheduler / housekeeping job)
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const networkCalls = sqliteTable(
  "network_calls",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    domain: text("domain").notNull(),
    purpose: text("purpose").notNull(),
    dataType: text("data_type").notNull().default("metadata"),
    initiator: text("initiator").notNull().default("automatic"),
    bytesSent: integer("bytes_sent").notNull().default(0),
    bytesReceived: integer("bytes_received").notNull().default(0),
    statusCode: integer("status_code"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_network_calls_tenant").on(t.tenantId),
    workspaceIdx: index("idx_network_calls_workspace").on(t.workspaceId),
    domainIdx: index("idx_network_calls_domain").on(t.tenantId, t.domain),
    createdIdx: index("idx_network_calls_created").on(t.tenantId, t.createdAt),
  }),
);

export type NetworkCall = typeof networkCalls.$inferSelect;
export type NewNetworkCall = typeof networkCalls.$inferInsert;
