/**
 * `audit_log_entries` — tamper-evident, append-only audit trail.
 *
 * Every row carries the SHA-256 hash of the previous row's `entryHash` and
 * its own canonical payload. Verifying the chain is just walking the rows
 * in `created_at` order and recomputing each `entryHash`; any mismatch
 * proves the log was edited.
 *
 * Append-only at the application layer (the audit service refuses to
 * UPDATE / DELETE these rows). The tier-review schema check exempts
 * tables containing the word "audit" from the version requirement
 * because mutation is forbidden by contract.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const auditLogEntries = sqliteTable(
  "audit_log_entries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    sequence: integer("sequence").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    summary: text("summary").notNull(),
    previousHash: text("previous_hash"),
    entryHash: text("entry_hash").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_audit_log_entries_tenant").on(t.tenantId),
    workspaceIdx: index("idx_audit_log_entries_workspace").on(t.workspaceId),
    sequenceIdx: index("idx_audit_log_entries_sequence").on(t.tenantId, t.sequence),
    createdIdx: index("idx_audit_log_entries_created").on(t.tenantId, t.createdAt),
  }),
);

export type AuditLogEntry = typeof auditLogEntries.$inferSelect;
export type NewAuditLogEntry = typeof auditLogEntries.$inferInsert;
