/**
 * `clean_shutdown_log` — append-only record of every clean process
 * shutdown (Task #58 — Crash Recovery & Mid-Task Resumption).
 *
 * The startup crash detector compares the most recent row against the
 * latest task activity: if any task is still flagged `running` /
 * `in_progress` and was last updated AFTER the most recent shutdown
 * row's `shutdownAt`, the task was abandoned by a hard crash and is
 * surfaced in the recovery prompt.
 *
 * Rows are global (no tenant scope) — there is one host process and
 * shutdown is a process-level event. We keep the most recent ~200 rows
 * for diagnostic value and prune older entries on each new write.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const cleanShutdownLog = sqliteTable(
  "clean_shutdown_log",
  {
    id: text("id").primaryKey(),
    // Host-level event: tenantId is pinned to the `_global_` sentinel so
    // the row satisfies the workspace-wide multi-tenancy invariant
    // without implying the event is scoped to any one tenant.
    tenantId: text("tenant_id").notNull().default("_global_"),
    reason: text("reason").notNull().default("normal"),
    pausedTaskIds: text("paused_task_ids"),
    pid: integer("pid"),
    shutdownAt: integer("shutdown_at").notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    shutdownIdx: index("idx_clean_shutdown_at").on(t.shutdownAt),
    tenantIdx: index("idx_clean_shutdown_tenant").on(t.tenantId),
  }),
);

export type CleanShutdownRow = typeof cleanShutdownLog.$inferSelect;
export type NewCleanShutdownRow = typeof cleanShutdownLog.$inferInsert;
