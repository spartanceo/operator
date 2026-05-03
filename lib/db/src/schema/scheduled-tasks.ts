/**
 * `scheduled_tasks` — recurring/timed automation jobs (Task #45).
 *
 * Each row represents a user-defined schedule: a prompt that the agent
 * loop should run on a cron-driven cadence. The scheduler engine in
 * `schedules.service.ts` reads `next_run_at <= now` rows on its tick,
 * kicks off an agent run, and refreshes `next_run_at` from the
 * `cron_expression`. `last_run_status` mirrors the agent run's outcome.
 *
 * `paused` is a per-row pause; the global "pause all schedules" toggle
 * lives in `schedule_settings`.
 *
 * `taskContext` is a JSON snapshot the user attached when creating the
 * schedule (knowledge collection, model name, conversation thread to
 * append into). The scheduler hands it to `createAgentRun()` verbatim
 * so the run looks identical to one the user kicked off manually.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    cronExpression: text("cron_expression").notNull(),
    naturalLanguage: text("natural_language"),
    timezone: text("timezone").notNull().default("UTC"),
    recurrenceKind: text("recurrence_kind").notNull().default("custom"),
    paused: integer("paused").notNull().default(0),
    taskContext: text("task_context"),
    lastRunAt: integer("last_run_at"),
    lastRunStatus: text("last_run_status"),
    lastRunSummary: text("last_run_summary"),
    nextRunAt: integer("next_run_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_scheduled_tasks_tenant").on(t.tenantId),
    workspaceIdx: index("idx_scheduled_tasks_workspace").on(t.workspaceId),
    nextRunIdx: index("idx_scheduled_tasks_next_run").on(t.tenantId, t.nextRunAt),
    pausedIdx: index("idx_scheduled_tasks_paused").on(t.tenantId, t.paused),
  }),
);

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;

/**
 * `scheduled_task_runs` — execution history for each schedule.
 *
 * One row per scheduler tick that decided to fire the schedule, including
 * "missed" rows the wake-up reconciler emits when the app was asleep at
 * the originally-scheduled time. Capped at 10 visible per schedule by the
 * service-layer pruner so the table never grows unbounded.
 */
export const scheduledTaskRuns = sqliteTable(
  "scheduled_task_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    scheduledTaskId: text("scheduled_task_id").notNull().references(() => scheduledTasks.id),
    scheduledFor: integer("scheduled_for").notNull(),
    startedAt: integer("started_at").notNull().default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at"),
    status: text("status").notNull().default("running"),
    summary: text("summary"),
    error: text("error"),
    agentRunId: text("agent_run_id"),
    triggerKind: text("trigger_kind").notNull().default("scheduled"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_scheduled_task_runs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_scheduled_task_runs_workspace").on(t.workspaceId),
    scheduleIdx: index("idx_scheduled_task_runs_schedule").on(
      t.tenantId,
      t.scheduledTaskId,
      t.startedAt,
    ),
    statusIdx: index("idx_scheduled_task_runs_status").on(t.tenantId, t.status),
  }),
);

export type ScheduledTaskRun = typeof scheduledTaskRuns.$inferSelect;
export type NewScheduledTaskRun = typeof scheduledTaskRuns.$inferInsert;

/**
 * `schedule_settings` — per-tenant scheduler controls.
 *
 * Singleton row keyed by tenant_id. Currently only carries the global
 * "pause all schedules" flag (used for "I need the machine for intensive
 * work right now") and the timestamp of the last reconciliation tick so
 * the wake-up handler can detect long gaps.
 */
export const scheduleSettings = sqliteTable(
  "schedule_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    globalPaused: integer("global_paused").notNull().default(0),
    lastTickAt: integer("last_tick_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_schedule_settings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_schedule_settings_workspace").on(t.workspaceId),
  }),
);

export type ScheduleSettings = typeof scheduleSettings.$inferSelect;
export type NewScheduleSettings = typeof scheduleSettings.$inferInsert;
