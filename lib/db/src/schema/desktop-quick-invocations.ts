/**
 * `desktop_quick_invocations` — append-friendly audit of every quick-input,
 * tray-dropdown, and right-click "Ask OP" entry point invocation
 * (Task #52).
 *
 * Each row captures:
 *   - `source`  : the entry point — "hotkey" | "tray" | "context_menu_macos"
 *                 | "context_menu_windows" | "menu_bar"
 *   - `surface` : visual surface the user saw — "quick_input" | "tray_dropdown"
 *                 | "service_menu" | "shell_extension"
 *   - `prompt`  : the text the user typed (or the default service prompt for
 *                 right-click flows like "Ask OP about this")
 *   - `contextKind` + `contextText` : optional clipboard / selected-text
 *                 context injected into the prompt — `none` if no selection
 *                 was active, otherwise the captured text (capped by the
 *                 service before insertion to keep rows bounded).
 *   - `applicationHint` : the front-most application name when known, so
 *                 the activity feed can show "from Slack" or similar.
 *   - `relatedTaskId` / `relatedRunId` / `notificationId` : the queued
 *                 task / agent run / notification rows that the invocation
 *                 produced, so the activity centre can link the timeline.
 *   - `expanded` : whether the user clicked "expand to full app" on the
 *                 floating quick-input window (UX telemetry).
 *
 * Append-friendly: the table omits the optimistic-concurrency `version`
 * column intentionally — invocations are immutable once written, mirroring
 * the audit-class carve-out used by `activity_events`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const desktopQuickInvocations = sqliteTable(
  "desktop_quick_invocations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    source: text("source").notNull(),
    surface: text("surface").notNull(),
    prompt: text("prompt").notNull(),
    /** "none" | "clipboard" | "selection". */
    contextKind: text("context_kind").notNull().default("none"),
    contextText: text("context_text"),
    applicationHint: text("application_hint"),
    relatedTaskId: text("related_task_id"),
    relatedRunId: text("related_run_id"),
    notificationId: text("notification_id"),
    expanded: integer("expanded").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_desktop_quick_inv_tenant").on(t.tenantId),
    workspaceIdx: index("idx_desktop_quick_inv_workspace").on(t.workspaceId),
    createdIdx: index("idx_desktop_quick_inv_created").on(t.tenantId, t.createdAt),
    sourceIdx: index("idx_desktop_quick_inv_source").on(t.tenantId, t.source),
  }),
);

export type DesktopQuickInvocation = typeof desktopQuickInvocations.$inferSelect;
export type NewDesktopQuickInvocation = typeof desktopQuickInvocations.$inferInsert;
