/**
 * `desktop_steps` — one row per LAV step inside a desktop session.
 *
 * Every step targets the screen by SEMANTIC description (what the user
 * sees: "the blue Save button in the toolbar"), never raw coordinates.
 * The verifier compares `expectedState` against `observedState` after each
 * action and records the verdict on the row.
 *
 * Risk gating: `needsApproval = 1` plus `riskLevel >= medium` requires a
 * row in `approvals` to be flipped to `approved` before `status` advances
 * past `awaiting_approval`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { approvals } from "./approvals";
import { desktopSessions } from "./desktop-sessions";
import { tenants } from "./tenants";
import { toolCalls } from "./tool-calls";
import { workspaces } from "./workspaces";

export const desktopSteps = sqliteTable(
  "desktop_steps",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    sessionId: text("session_id").notNull().references(() => desktopSessions.id),
    stepIndex: integer("step_index").notNull().default(0),
    actionType: text("action_type").notNull(),
    targetDescription: text("target_description").notNull().default(""),
    targetRole: text("target_role"),
    targetLabel: text("target_label"),
    inputValue: text("input_value"),
    riskLevel: text("risk_level").notNull().default("medium"),
    needsApproval: integer("needs_approval").notNull().default(1),
    status: text("status").notNull().default("pending"),
    expectedState: text("expected_state"),
    observedState: text("observed_state"),
    verifyAttempts: integer("verify_attempts").notNull().default(0),
    toolCallId: text("tool_call_id").references(() => toolCalls.id),
    approvalId: text("approval_id").references(() => approvals.id),
    error: text("error"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_desktop_steps_tenant").on(t.tenantId),
    workspaceIdx: index("idx_desktop_steps_workspace").on(t.workspaceId),
    sessionIdx: index("idx_desktop_steps_session").on(t.sessionId),
    toolCallIdx: index("idx_desktop_steps_tool_call").on(t.toolCallId),
    approvalIdx: index("idx_desktop_steps_approval").on(t.approvalId),
    statusIdx: index("idx_desktop_steps_status").on(t.tenantId, t.status),
  }),
);

export type DesktopStep = typeof desktopSteps.$inferSelect;
export type NewDesktopStep = typeof desktopSteps.$inferInsert;
