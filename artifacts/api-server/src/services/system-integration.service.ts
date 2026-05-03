/**
 * System-integration service — global hotkey, quick-input overlay, menu
 * bar / system tray, right-click "Ask OP" services, focus-mode awareness,
 * and login-item registration (Task #52).
 *
 * The HTTP routes here are the contract the Electron desktop shell calls
 * into. The shell owns the actual OS surfaces (`globalShortcut`, `Tray`,
 * macOS Service plist, Windows shell extension, `app.setLoginItemSettings`,
 * `nativeNotifications` Focus integration). All of those surfaces store
 * their state and channel their invocations through this service so the
 * web frontend can show settings / history without duplicating logic.
 *
 * Tenant scope (Standard 5) is enforced on every read and write — the
 * settings row is keyed by `(tenant_id, workspace_id)` and the
 * invocation history table carries the same scope.
 *
 * Focus-mode awareness: the `focusModeActive` flag on the settings row
 * is consulted by `notifications.service.createNotification` to suppress
 * non-critical categories when macOS Focus Mode or Windows Focus Assist
 * is engaged — see `isFocusModeActive` below.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  desktopIntegrationSettings,
  desktopQuickInvocations,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { recordActivity } from "./activity.service";
import { listApprovals } from "./approvals.service";
import {
  createNotification,
  getUnreadCount,
} from "./notifications.service";
import { enqueueTask } from "./task-queue.service";

// ─── Constants + canonical enums ────────────────────────────────────────────

export const QUICK_INVOCATION_SOURCES = [
  "hotkey",
  "tray",
  "menu_bar",
  "context_menu_macos",
  "context_menu_windows",
] as const;
export type QuickInvocationSource = (typeof QUICK_INVOCATION_SOURCES)[number];

export const QUICK_INVOCATION_SURFACES = [
  "quick_input",
  "tray_dropdown",
  "service_menu",
  "shell_extension",
] as const;
export type QuickInvocationSurface = (typeof QUICK_INVOCATION_SURFACES)[number];

export const CONTEXT_KINDS = ["none", "clipboard", "selection"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const TRAY_BADGE_MODES = ["count", "dot", "none"] as const;
export type TrayBadgeMode = (typeof TRAY_BADGE_MODES)[number];

export const FOCUS_MODE_SOURCES = ["macos", "windows", "manual"] as const;
export type FocusModeSource = (typeof FOCUS_MODE_SOURCES)[number];

/** Hard cap so a malicious / runaway selection cannot blow up the DB. */
const MAX_CONTEXT_TEXT = 8_000;
/** Tray dropdown only ever needs the most recent handful of activity. */
const TRAY_RECENT_LIMIT = 5;

// Categories that are considered *critical* and therefore bypass focus
// mode suppression. Approvals and errors must always reach the user even
// when DND is on — silently dropping an approval would block the agent
// loop indefinitely.
const FOCUS_BYPASS_CATEGORIES: ReadonlySet<string> = new Set([
  "approval",
  "error",
]);

// ─── Public types ───────────────────────────────────────────────────────────

export interface DesktopIntegrationSettingsRow {
  hotkeyMac: string;
  hotkeyWindows: string;
  hotkeyEnabled: boolean;
  hotkeyConflict: string | null;
  trayEnabled: boolean;
  trayBadgeMode: TrayBadgeMode;
  loginItemEnabled: boolean;
  loginItemConsentAt: string | null;
  focusModeActive: boolean;
  focusModeSource: FocusModeSource | null;
  focusModeUpdatedAt: string | null;
  rightClickMacEnabled: boolean;
  rightClickWindowsEnabled: boolean;
  updatedAt: string;
}

export interface UpdateSettingsInput {
  hotkeyMac?: string;
  hotkeyWindows?: string;
  hotkeyEnabled?: boolean;
  trayEnabled?: boolean;
  trayBadgeMode?: TrayBadgeMode;
  rightClickMacEnabled?: boolean;
  rightClickWindowsEnabled?: boolean;
}

export interface LoginItemConsentInput {
  enabled: boolean;
}

export interface FocusModeInput {
  active: boolean;
  source: FocusModeSource;
}

export interface QuickInvocationInput {
  prompt: string;
  source: QuickInvocationSource;
  surface?: QuickInvocationSurface;
  contextKind?: ContextKind;
  contextText?: string;
  applicationHint?: string;
  expanded?: boolean;
  /** When false, the route only records the invocation — it does not
   *  enqueue an agent task. Used by the frontend "save for later" path. */
  enqueue?: boolean;
}

export interface QuickInvocationRow {
  id: string;
  source: string;
  surface: string;
  prompt: string;
  contextKind: string;
  contextText: string | null;
  applicationHint: string | null;
  relatedTaskId: string | null;
  relatedRunId: string | null;
  notificationId: string | null;
  expanded: boolean;
  createdAt: string;
}

export interface TrayStatusBadge {
  mode: TrayBadgeMode;
  /** Numeric badge value when `mode === "count"`; null otherwise. */
  count: number | null;
  /** "idle" | "active" | "error" — drives the tray icon animation. */
  iconState: "idle" | "active" | "error";
}

export interface TrayStatusResponse {
  badge: TrayStatusBadge;
  unreadNotifications: number;
  pendingApprovals: number;
  activeTasks: number;
  recentInvocations: QuickInvocationRow[];
  focusModeActive: boolean;
  hotkeyEnabled: boolean;
}

export interface HotkeyConflictReport {
  /** OS-reported conflicting binding (e.g. another app already owns `⌘ Space`). */
  binding: string;
  detail?: string;
}

// ─── Mappers ────────────────────────────────────────────────────────────────

function toSettings(
  r: typeof desktopIntegrationSettings.$inferSelect,
): DesktopIntegrationSettingsRow {
  const badgeMode: TrayBadgeMode = (TRAY_BADGE_MODES as readonly string[]).includes(
    r.trayBadgeMode,
  )
    ? (r.trayBadgeMode as TrayBadgeMode)
    : "count";
  const focusSource: FocusModeSource | null = r.focusModeSource &&
    (FOCUS_MODE_SOURCES as readonly string[]).includes(r.focusModeSource)
    ? (r.focusModeSource as FocusModeSource)
    : null;
  return {
    hotkeyMac: r.hotkeyMac,
    hotkeyWindows: r.hotkeyWindows,
    hotkeyEnabled: r.hotkeyEnabled === 1,
    hotkeyConflict: r.hotkeyConflict,
    trayEnabled: r.trayEnabled === 1,
    trayBadgeMode: badgeMode,
    loginItemEnabled: r.loginItemEnabled === 1,
    loginItemConsentAt: r.loginItemConsentAt
      ? new Date(r.loginItemConsentAt).toISOString()
      : null,
    focusModeActive: r.focusModeActive === 1,
    focusModeSource: focusSource,
    focusModeUpdatedAt: r.focusModeUpdatedAt
      ? new Date(r.focusModeUpdatedAt).toISOString()
      : null,
    rightClickMacEnabled: r.rightClickMacEnabled === 1,
    rightClickWindowsEnabled: r.rightClickWindowsEnabled === 1,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toInvocation(
  r: typeof desktopQuickInvocations.$inferSelect,
): QuickInvocationRow {
  return {
    id: r.id,
    source: r.source,
    surface: r.surface,
    prompt: r.prompt,
    contextKind: r.contextKind,
    contextText: r.contextText,
    applicationHint: r.applicationHint,
    relatedTaskId: r.relatedTaskId,
    relatedRunId: r.relatedRunId,
    notificationId: r.notificationId,
    expanded: r.expanded === 1,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

// ─── Settings: read / upsert ────────────────────────────────────────────────

async function loadSettingsRow(
  ctx: TenantContext,
): Promise<typeof desktopIntegrationSettings.$inferSelect | null> {
  const rows = await db
    .select()
    .from(desktopIntegrationSettings)
    .where(tenantScope(ctx, desktopIntegrationSettings))
    .limit(1);
  return rows[0] ?? null;
}

async function ensureSettingsRow(
  ctx: TenantContext,
): Promise<typeof desktopIntegrationSettings.$inferSelect> {
  const existing = await loadSettingsRow(ctx);
  if (existing) return existing;
  const id = `dis_${nanoid()}`;
  await db
    .insert(desktopIntegrationSettings)
    .values(withTenantValues(ctx, { id }));
  const fresh = await loadSettingsRow(ctx);
  if (!fresh) {
    throw new Error("Settings row vanished immediately after insert");
  }
  return fresh;
}

export async function getSettings(
  ctx: TenantContext,
): Promise<DesktopIntegrationSettingsRow> {
  const row = await ensureSettingsRow(ctx);
  return toSettings(row);
}

export async function updateSettings(
  ctx: TenantContext,
  input: UpdateSettingsInput,
): Promise<DesktopIntegrationSettingsRow> {
  const existing = await ensureSettingsRow(ctx);
  const now = Date.now();
  const patch: Partial<typeof desktopIntegrationSettings.$inferInsert> = {
    updatedAt: now,
    version: existing.version + 1,
  };
  if (input.hotkeyMac !== undefined) patch.hotkeyMac = input.hotkeyMac;
  if (input.hotkeyWindows !== undefined) patch.hotkeyWindows = input.hotkeyWindows;
  if (input.hotkeyEnabled !== undefined) {
    patch.hotkeyEnabled = input.hotkeyEnabled ? 1 : 0;
    // Clear any prior conflict report when the user re-enables.
    if (input.hotkeyEnabled) patch.hotkeyConflict = null;
  }
  if (input.trayEnabled !== undefined) {
    patch.trayEnabled = input.trayEnabled ? 1 : 0;
  }
  if (input.trayBadgeMode !== undefined) patch.trayBadgeMode = input.trayBadgeMode;
  if (input.rightClickMacEnabled !== undefined) {
    patch.rightClickMacEnabled = input.rightClickMacEnabled ? 1 : 0;
  }
  if (input.rightClickWindowsEnabled !== undefined) {
    patch.rightClickWindowsEnabled = input.rightClickWindowsEnabled ? 1 : 0;
  }
  await db
    .update(desktopIntegrationSettings)
    .set(patch)
    .where(
      and(
        tenantScope(ctx, desktopIntegrationSettings),
        eq(desktopIntegrationSettings.id, existing.id),
      ),
    );
  return getSettings(ctx);
}

/**
 * Report a hotkey conflict detected by the Electron main process so the
 * frontend can render a "Your shortcut is already used by ___" warning
 * and prompt the user to pick another binding.
 */
export async function reportHotkeyConflict(
  ctx: TenantContext,
  conflict: HotkeyConflictReport,
): Promise<DesktopIntegrationSettingsRow> {
  const existing = await ensureSettingsRow(ctx);
  const detail = conflict.detail
    ? `${conflict.binding} (${conflict.detail})`
    : conflict.binding;
  const now = Date.now();
  await db
    .update(desktopIntegrationSettings)
    .set({
      hotkeyConflict: detail,
      hotkeyEnabled: 0,
      updatedAt: now,
      version: existing.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, desktopIntegrationSettings),
        eq(desktopIntegrationSettings.id, existing.id),
      ),
    );
  await recordActivity(ctx, {
    eventType: "system",
    actor: ctx.userId ?? ctx.tenantId,
    summary: `Global hotkey disabled — conflict with ${detail}`,
    outcome: "failure",
  });
  return getSettings(ctx);
}

export async function setLoginItem(
  ctx: TenantContext,
  input: LoginItemConsentInput,
): Promise<DesktopIntegrationSettingsRow> {
  const existing = await ensureSettingsRow(ctx);
  const now = Date.now();
  await db
    .update(desktopIntegrationSettings)
    .set({
      loginItemEnabled: input.enabled ? 1 : 0,
      loginItemConsentAt: input.enabled ? now : null,
      updatedAt: now,
      version: existing.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, desktopIntegrationSettings),
        eq(desktopIntegrationSettings.id, existing.id),
      ),
    );
  await recordActivity(ctx, {
    eventType: "system",
    actor: ctx.userId ?? ctx.tenantId,
    summary: input.enabled
      ? "Registered Omninity Operator as a login item"
      : "Removed Omninity Operator from login items",
  });
  return getSettings(ctx);
}

export async function setFocusMode(
  ctx: TenantContext,
  input: FocusModeInput,
): Promise<DesktopIntegrationSettingsRow> {
  const existing = await ensureSettingsRow(ctx);
  const now = Date.now();
  await db
    .update(desktopIntegrationSettings)
    .set({
      focusModeActive: input.active ? 1 : 0,
      focusModeSource: input.source,
      focusModeUpdatedAt: now,
      updatedAt: now,
      version: existing.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, desktopIntegrationSettings),
        eq(desktopIntegrationSettings.id, existing.id),
      ),
    );
  return getSettings(ctx);
}

/**
 * Cheap, non-throwing focus-mode probe consumed by `notifications.service`.
 * Missing settings rows are treated as "focus inactive" — the most-permissive
 * default, matching the rest of the integration layer.
 */
export async function isFocusModeActive(ctx: TenantContext): Promise<boolean> {
  const row = await loadSettingsRow(ctx);
  return row?.focusModeActive === 1;
}

/**
 * Categories that should bypass focus-mode suppression. Re-exported so the
 * notifications service can consult the same allowlist without redefining
 * it.
 */
export function focusModeBypasses(category: string): boolean {
  return FOCUS_BYPASS_CATEGORIES.has(category);
}

// ─── Quick invocations: hotkey / tray / right-click → agent task ────────────

function clampContext(
  kind: ContextKind | undefined,
  text: string | undefined,
): { kind: ContextKind; text: string | null } {
  if (!kind || kind === "none") return { kind: "none", text: null };
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { kind: "none", text: null };
  const capped = trimmed.length > MAX_CONTEXT_TEXT
    ? `${trimmed.slice(0, MAX_CONTEXT_TEXT)}…`
    : trimmed;
  return { kind, text: capped };
}

function buildPromptWithContext(
  prompt: string,
  contextKind: ContextKind,
  contextText: string | null,
): string {
  if (contextKind === "none" || !contextText) return prompt;
  // Selection / clipboard text is folded in as a labelled block so the
  // agent planner can distinguish "the user typed this" from "the user
  // selected this" without us needing a separate parameter.
  const label = contextKind === "selection" ? "Selected text" : "Clipboard";
  return `${prompt}\n\n--- ${label} ---\n${contextText}`;
}

export async function recordQuickInvocation(
  ctx: TenantContext,
  input: QuickInvocationInput,
): Promise<{ invocation: QuickInvocationRow; relatedTaskId: string | null }> {
  // Surface defaults: hotkey + menu bar both land in the floating
  // quick-input window; the right-click sources land in their respective
  // OS-native surfaces.
  const surface: QuickInvocationSurface =
    input.surface ??
    (input.source === "context_menu_macos"
      ? "service_menu"
      : input.source === "context_menu_windows"
        ? "shell_extension"
        : input.source === "tray"
          ? "tray_dropdown"
          : "quick_input");

  const { kind, text } = clampContext(input.contextKind, input.contextText);
  const composed = buildPromptWithContext(input.prompt, kind, text);

  let relatedTaskId: string | null = null;
  let relatedRunId: string | null = null;
  let notificationId: string | null = null;

  // Right-click invocations and hotkey invocations should auto-enqueue by
  // default — that is the whole point of the flow ("ask OP about this and
  // tell me when it's done"). The caller can opt out via `enqueue: false`.
  if (input.enqueue !== false) {
    try {
      const queued = await enqueueTask(ctx, { goal: composed });
      relatedTaskId = queued.id;
    } catch (e) {
      // Surface the failure, don't lose the invocation row.
      logger.error(
        { err: e, source: input.source },
        "Quick invocation failed to enqueue task",
      );
    }
  }

  const id = `dqi_${nanoid()}`;
  await db.insert(desktopQuickInvocations).values(
    withTenantValues(ctx, {
      id,
      source: input.source,
      surface,
      prompt: input.prompt,
      contextKind: kind,
      contextText: text,
      applicationHint: input.applicationHint ?? null,
      relatedTaskId,
      relatedRunId,
      notificationId,
      expanded: input.expanded ? 1 : 0,
    }),
  );

  // Friendly "we got your task, working on it" toast — falls through the
  // category-prefs + focus-mode suppression already in place.
  if (relatedTaskId) {
    const note = await createNotification(ctx, {
      category: "task",
      title: "OP is on it",
      body: input.prompt.length > 140
        ? `${input.prompt.slice(0, 140)}…`
        : input.prompt,
      severity: "info",
    });
    if (note) {
      notificationId = note.id;
      await db
        .update(desktopQuickInvocations)
        .set({ notificationId, updatedAt: Date.now() })
        .where(
          and(
            tenantScope(ctx, desktopQuickInvocations),
            eq(desktopQuickInvocations.id, id),
          ),
        );
    }
  }

  await recordActivity(ctx, {
    eventType: "system",
    actor: ctx.userId ?? ctx.tenantId,
    summary: `Quick invocation via ${input.source}: ${input.prompt.slice(0, 80)}`,
    metadata: {
      source: input.source,
      surface,
      contextKind: kind,
      applicationHint: input.applicationHint ?? null,
      relatedTaskId,
    },
  });

  const fresh = await db
    .select()
    .from(desktopQuickInvocations)
    .where(
      and(
        tenantScope(ctx, desktopQuickInvocations),
        eq(desktopQuickInvocations.id, id),
      ),
    )
    .limit(1);
  if (!fresh[0]) throw new Error("Quick invocation vanished after insert");
  return { invocation: toInvocation(fresh[0]), relatedTaskId };
}

export async function listQuickInvocations(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<QuickInvocationRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, desktopQuickInvocations);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(desktopQuickInvocations.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(desktopQuickInvocations)
    .where(where)
    .orderBy(desc(desktopQuickInvocations.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toInvocation), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

// ─── Menu bar / system tray status snapshot ─────────────────────────────────

export async function getTrayStatus(
  ctx: TenantContext,
): Promise<TrayStatusResponse> {
  const settings = await getSettings(ctx);

  // Pending approvals + unread notifications drive the badge / icon state.
  const [unread, pendingPage, recentRows] = await Promise.all([
    getUnreadCount(ctx),
    listApprovals(ctx, { decision: "pending", limit: 50 }),
    db
      .select()
      .from(desktopQuickInvocations)
      .where(tenantScope(ctx, desktopQuickInvocations))
      .orderBy(desc(desktopQuickInvocations.createdAt))
      .limit(TRAY_RECENT_LIMIT),
  ]);

  const pendingApprovals = pendingPage.items.length;
  // Active task count is approximated from pending invocations whose
  // related task has not yet emitted a completion notification — the
  // task-queue service owns the source-of-truth, so we keep this cheap
  // by counting in-progress invocations from the last hour.
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentForActive = recentRows.filter(
    (r) => r.relatedTaskId && r.createdAt >= oneHourAgo,
  );
  const activeTasks = recentForActive.length;

  const iconState: TrayStatusBadge["iconState"] = pendingApprovals > 0
    ? "error"
    : activeTasks > 0
      ? "active"
      : "idle";

  const badge: TrayStatusBadge = {
    mode: settings.trayBadgeMode,
    count: settings.trayBadgeMode === "count"
      ? pendingApprovals + unread
      : null,
    iconState,
  };

  return {
    badge,
    unreadNotifications: unread,
    pendingApprovals,
    activeTasks,
    recentInvocations: recentRows.map(toInvocation),
    focusModeActive: settings.focusModeActive,
    hotkeyEnabled: settings.hotkeyEnabled,
  };
}
