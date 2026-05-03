/**
 * `erasure_requests` — GDPR right-to-erasure request log.
 *
 * For enterprise deployments where OP has a cloud component, the user can
 * file a formal erasure request. The request is recorded here and processed
 * out-of-band by the platform team. Local-only installs use the
 * `data-nuke` flow instead.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const erasureRequests = sqliteTable(
  "erasure_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    requesterEmail: text("requester_email").notNull(),
    scope: text("scope").notNull().default("all"),
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_erasure_requests_tenant").on(t.tenantId),
    workspaceIdx: index("idx_erasure_requests_workspace").on(t.workspaceId),
    statusIdx: index("idx_erasure_requests_status").on(t.tenantId, t.status),
    createdIdx: index("idx_erasure_requests_created").on(t.tenantId, t.createdAt),
  }),
);

export type ErasureRequest = typeof erasureRequests.$inferSelect;
export type NewErasureRequest = typeof erasureRequests.$inferInsert;
