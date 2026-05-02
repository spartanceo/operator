/**
 * `desktop_sessions` — one row per Operator Desktop Control session.
 *
 * A session captures the full LAV (Look → Act → Verify) cycle: the user
 * goal, the planner output, lifecycle status, and a JSON-serialised plan
 * snapshot for replay. Each session optionally links back to an `agentRuns`
 * row when the desktop session is invoked from the broader agent loop.
 *
 * Status walks `planning → awaiting_approval → running → completed | failed
 * | stopped`. The orchestrator advances it; routes only ever READ status
 * here and use the dedicated stop endpoint to flip to `stopped`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { agentRuns } from "./agent-runs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const desktopSessions = sqliteTable(
  "desktop_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    runId: text("run_id").references(() => agentRuns.id),
    goal: text("goal").notNull(),
    status: text("status").notNull().default("planning"),
    mode: text("mode").notNull().default("sequential"),
    planJson: text("plan_json"),
    summary: text("summary"),
    error: text("error"),
    modelName: text("model_name"),
    startedAt: integer("started_at"),
    stoppedAt: integer("stopped_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_desktop_sessions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_desktop_sessions_workspace").on(t.workspaceId),
    runIdx: index("idx_desktop_sessions_run").on(t.runId),
    statusIdx: index("idx_desktop_sessions_status").on(t.tenantId, t.status),
  }),
);

export type DesktopSession = typeof desktopSessions.$inferSelect;
export type NewDesktopSession = typeof desktopSessions.$inferInsert;
