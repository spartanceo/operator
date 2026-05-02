/**
 * `workspaces` — the second tier of isolation inside a tenant.
 *
 * A tenant has one or more workspaces; data inside a workspace is invisible
 * to peer workspaces of the same tenant. The `tenantScope` helper adds the
 * workspace filter automatically when both the table and the request
 * context carry one (Standard 13).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_workspaces_tenant").on(t.tenantId),
    tenantStatusIdx: index("idx_workspaces_tenant_status").on(t.tenantId, t.status),
  }),
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
