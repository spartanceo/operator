/**
 * `workspace_adapter_assignments` — workspace-scoped LoRA adapter
 * activation (Task #47).
 *
 * For each (workspace, baseModel) pair, at most one adapter is active.
 * When the agent loop selects a model that has an active adapter for the
 * current workspace, the runtime loads the adapter alongside the base
 * model. Setting `adapterId` to NULL clears the assignment.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const workspaceAdapterAssignments = sqliteTable(
  "workspace_adapter_assignments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Base model the assignment applies to. */
    baseModel: text("base_model").notNull(),
    /** Adapter id, or empty string when explicitly cleared. */
    adapterId: text("adapter_id").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_workspace_adapter_assignments_tenant").on(t.tenantId),
    workspaceIdx: index("idx_workspace_adapter_assignments_workspace").on(t.workspaceId),
    pairIdx: uniqueIndex("uq_workspace_adapter_assignments_pair").on(
      t.workspaceId,
      t.baseModel,
    ),
  }),
);

export type WorkspaceAdapterAssignment = typeof workspaceAdapterAssignments.$inferSelect;
export type NewWorkspaceAdapterAssignment = typeof workspaceAdapterAssignments.$inferInsert;
