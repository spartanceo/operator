/**
 * `task_satisfaction_ratings` — append-only thumbs up/down captured after
 * an agent run completes. A positive rating is the trigger for the in-app
 * share prompt (Task #35 — virality triggers).
 *
 * Append-only audit-class table — no `version` column.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const taskSatisfactionRatings = sqliteTable(
  "task_satisfaction_ratings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    runId: text("run_id"),
    rating: text("rating").notNull(),
    summary: text("summary"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_task_satisfaction_tenant").on(t.tenantId),
    workspaceIdx: index("idx_task_satisfaction_workspace").on(t.workspaceId),
    runIdx: index("idx_task_satisfaction_run").on(t.tenantId, t.runId),
    ratingIdx: index("idx_task_satisfaction_rating").on(t.tenantId, t.rating),
  }),
);

export type TaskSatisfactionRating = typeof taskSatisfactionRatings.$inferSelect;
export type NewTaskSatisfactionRating = typeof taskSatisfactionRatings.$inferInsert;
