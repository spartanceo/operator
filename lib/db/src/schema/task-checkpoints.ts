/**
 * `task_checkpoints` — durable per-step record of a queued task's progress
 * (Task #58 — Crash Recovery & Mid-Task Resumption).
 *
 * Every step the executor runs writes one row here BEFORE it executes
 * (status = `in_progress`) and updates that row AFTER it finishes
 * (status = `completed` / `failed`). The two-phase write is what makes
 * the checkpoint useful: a hard crash mid-execution leaves an
 * `in_progress` row pointing at exactly the step that didn't finish.
 *
 * `stepKind` distinguishes destructive steps (`destructive = 1`) from
 * read-only ones — the checkpoint writer flushes destructive rows
 * synchronously so reversal information is always durable, and writes
 * read-only rows asynchronously so info-gathering steps incur no
 * latency cost.
 *
 * `inputs`, `outputs`, `toolCalls`, `approvals` are JSON blobs holding
 * the structured step data only — no raw model output is persisted, by
 * design, so the table stays compact across long multi-agent runs.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const taskCheckpoints = sqliteTable(
  "task_checkpoints",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    taskId: text("task_id").notNull(),
    runId: text("run_id"),
    stepIndex: integer("step_index").notNull(),
    stepKind: text("step_kind").notNull(),
    destructive: integer("destructive").notNull().default(0),
    status: text("status").notNull().default("in_progress"),
    summary: text("summary"),
    inputs: text("inputs"),
    outputs: text("outputs"),
    toolCalls: text("tool_calls"),
    approvals: text("approvals"),
    error: text("error"),
    requiredSkillIds: text("required_skill_ids"),
    requiredToolNames: text("required_tool_names"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_task_checkpoints_tenant").on(t.tenantId),
    workspaceIdx: index("idx_task_checkpoints_workspace").on(t.workspaceId),
    taskIdx: index("idx_task_checkpoints_task").on(t.tenantId, t.taskId, t.stepIndex),
    statusIdx: index("idx_task_checkpoints_status").on(t.tenantId, t.status),
  }),
);

export type TaskCheckpoint = typeof taskCheckpoints.$inferSelect;
export type NewTaskCheckpoint = typeof taskCheckpoints.$inferInsert;
