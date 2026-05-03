/**
 * `task_queue_entries` — multi-task queue rows (Task #38).
 *
 * A queued entry is the user's submission ("run goal X with model Y"). The
 * queue runner picks the highest-priority `queued` row, flips it to
 * `running`, drains it through the agent loop (which inserts an
 * `agent_runs` row + transcript), and writes back the resulting status +
 * `run_id`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const taskQueueEntries = sqliteTable(
  "task_queue_entries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    goal: text("goal").notNull(),
    modelName: text("model_name"),
    useKnowledgeBase: integer("use_knowledge_base").notNull().default(1),
    knowledgeCollectionId: text("knowledge_collection_id"),
    priority: text("priority").notNull().default("normal"),
    status: text("status").notNull().default("queued"),
    runId: text("run_id"),
    contextSnapshot: text("context_snapshot"),
    staleReason: text("stale_reason"),
    error: text("error"),
    summary: text("summary"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    pausedAt: integer("paused_at"),
    pauseReason: text("pause_reason"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_task_queue_tenant").on(t.tenantId),
    workspaceIdx: index("idx_task_queue_workspace").on(t.workspaceId),
    statusIdx: index("idx_task_queue_status").on(t.tenantId, t.status),
    createdIdx: index("idx_task_queue_created").on(t.tenantId, t.createdAt),
    priorityIdx: index("idx_task_queue_priority").on(
      t.tenantId,
      t.status,
      t.priority,
      t.createdAt,
    ),
  }),
);

export type TaskQueueEntry = typeof taskQueueEntries.$inferSelect;
export type NewTaskQueueEntry = typeof taskQueueEntries.$inferInsert;
