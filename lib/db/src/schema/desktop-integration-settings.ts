/**
 * `desktop_integration_settings` — singleton-per-tenant configuration for
 * the OS-level integration layer (Task #52).
 *
 * One row per (tenant, workspace) holds:
 *   - the configurable global hotkey bindings (Mac and Windows defaults)
 *   - whether the menu bar / system tray icon is shown
 *   - badge mode (count, dot, none) — controls how active/error state is
 *     surfaced to the OS shell
 *   - the user's explicit consent to register OP as a login item
 *   - the live focus-mode / Do-Not-Disturb state pushed from the Electron
 *     main process so the notification service can suppress non-critical
 *     toasts without re-querying the OS on every dispatch
 *   - per-platform right-click context-menu opt-in flags (macOS Service +
 *     Windows shell extension)
 *
 * Defaults are baked into the service layer so a missing row is treated
 * as "all features on, login item off, focus inactive".
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const desktopIntegrationSettings = sqliteTable(
  "desktop_integration_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    hotkeyMac: text("hotkey_mac").notNull().default("Command+Space+Space"),
    hotkeyWindows: text("hotkey_windows").notNull().default("Control+Shift+Space"),
    hotkeyEnabled: integer("hotkey_enabled").notNull().default(1),
    hotkeyConflict: text("hotkey_conflict"),
    trayEnabled: integer("tray_enabled").notNull().default(1),
    /** "count" | "dot" | "none". */
    trayBadgeMode: text("tray_badge_mode").notNull().default("count"),
    loginItemEnabled: integer("login_item_enabled").notNull().default(0),
    loginItemConsentAt: integer("login_item_consent_at"),
    focusModeActive: integer("focus_mode_active").notNull().default(0),
    /** "macos" | "windows" | "manual" — surface that pushed the state. */
    focusModeSource: text("focus_mode_source"),
    focusModeUpdatedAt: integer("focus_mode_updated_at"),
    rightClickMacEnabled: integer("right_click_mac_enabled").notNull().default(1),
    rightClickWindowsEnabled: integer("right_click_windows_enabled").notNull().default(1),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_desktop_int_settings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_desktop_int_settings_workspace").on(t.workspaceId),
    uniqIdx: uniqueIndex("idx_desktop_int_settings_unique").on(t.tenantId, t.workspaceId),
  }),
);

export type DesktopIntegrationSettings =
  typeof desktopIntegrationSettings.$inferSelect;
export type NewDesktopIntegrationSettings =
  typeof desktopIntegrationSettings.$inferInsert;
