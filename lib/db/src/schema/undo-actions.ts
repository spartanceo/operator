/**
 * `undo_actions` — per-tenant undo stack for desktop / file actions.
 *
 * Every reversible side-effect Omninity Operator performs (file move,
 * rename, copy, write, delete, folder create, form-field edit, clipboard
 * change) records a row here BEFORE the action runs, with a JSON snapshot
 * of the before-state. The reversal executors in `undo.service.ts` read
 * the snapshot to roll the action back.
 *
 * Irreversible actions (email send, terminal command, API call, purchase)
 * are also recorded with `reversible = 0` so the audit trail is complete
 * but `POST /api/undo/actions/:id` returns `IRREVERSIBLE`.
 *
 * `taskId` is optional and free-form: the orchestrator uses the desktop
 * session id, the agent run id, or the conversation id so "Undo entire
 * task" can find every related action in one query.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const undoActions = sqliteTable(
  "undo_actions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    taskId: text("task_id"),
    actionType: text("action_type").notNull(),
    description: text("description").notNull().default(""),
    target: text("target"),
    reversible: integer("reversible").notNull().default(1),
    status: text("status").notNull().default("available"),
    beforeState: text("before_state"),
    afterState: text("after_state"),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    undoneAt: integer("undone_at"),
    expiresAt: integer("expires_at"),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_undo_actions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_undo_actions_workspace").on(t.workspaceId),
    taskIdx: index("idx_undo_actions_task").on(t.tenantId, t.taskId),
    statusIdx: index("idx_undo_actions_status").on(t.tenantId, t.status),
    createdIdx: index("idx_undo_actions_created").on(t.tenantId, t.createdAt),
  }),
);

export type UndoAction = typeof undoActions.$inferSelect;
export type NewUndoAction = typeof undoActions.$inferInsert;
