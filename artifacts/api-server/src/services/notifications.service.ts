/**
 * Notifications service — in-app notification centre + OS dispatch hook.
 *
 * The notification flow:
 *   1. Some upstream service (agent loop, skill runtime, approvals, errors)
 *      calls `createNotification(ctx, input)` whenever the user needs to
 *      know about something.
 *   2. The row is persisted via `notifications` and surfaced through the
 *      bell-icon dropdown.
 *   3. If the desktop shell wants to dispatch a native OS toast it calls
 *      `claimUndispatchedNotifications(ctx)` which atomically flips
 *      `dispatched_to_os = 1` and returns the rows so the Electron main
 *      process can `new Notification(...)` them. Web-only deployments
 *      simply ignore the OS dispatch column.
 *
 * Per-category preferences live in `notification_preferences` — the
 * service consults them before persisting a row so a silenced category
 * never reaches the bell or the OS.
 */
import { and, count, desc, eq, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  notifications,
  notificationPreferences,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import {
  focusModeBypasses,
  isFocusModeActive,
} from "./system-integration.service";

export type NotificationCategory =
  | "task"
  | "approval"
  | "skill"
  | "error"
  | "system";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export interface NotificationInput {
  category: NotificationCategory;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  actionLabel?: string;
  actionHref?: string;
  relatedRunId?: string;
  relatedApprovalId?: string;
}

export interface NotificationRow {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  actionLabel: string | null;
  actionHref: string | null;
  relatedRunId: string | null;
  relatedApprovalId: string | null;
  read: boolean;
  readAt: string | null;
  dispatchedToOs: boolean;
  createdAt: string;
}

export interface CategoryPreference {
  inApp: boolean;
  os: boolean;
}

export type PreferenceMap = Record<NotificationCategory, CategoryPreference>;

const DEFAULT_PREFERENCES: PreferenceMap = {
  task: { inApp: true, os: true },
  approval: { inApp: true, os: true },
  skill: { inApp: true, os: true },
  error: { inApp: true, os: true },
  system: { inApp: true, os: false },
};

const CATEGORIES: ReadonlyArray<NotificationCategory> = [
  "task",
  "approval",
  "skill",
  "error",
  "system",
];

function toRow(r: typeof notifications.$inferSelect): NotificationRow {
  return {
    id: r.id,
    category: r.category,
    severity: r.severity,
    title: r.title,
    body: r.body,
    actionLabel: r.actionLabel,
    actionHref: r.actionHref,
    relatedRunId: r.relatedRunId,
    relatedApprovalId: r.relatedApprovalId,
    read: r.readAt !== null,
    readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
    dispatchedToOs: r.dispatchedToOs === 1,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function mergePreferences(stored: unknown): PreferenceMap {
  const merged: PreferenceMap = { ...DEFAULT_PREFERENCES };
  if (stored && typeof stored === "object") {
    for (const cat of CATEGORIES) {
      const entry = (stored as Record<string, unknown>)[cat];
      if (entry && typeof entry === "object") {
        const e = entry as Partial<CategoryPreference>;
        merged[cat] = {
          inApp: e.inApp !== false,
          os: e.os !== false,
        };
      }
    }
  }
  return merged;
}

export async function getNotificationPreferences(
  ctx: TenantContext,
): Promise<PreferenceMap> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(tenantScope(ctx, notificationPreferences))
    .limit(1);
  const row = rows[0];
  if (!row) return { ...DEFAULT_PREFERENCES };
  try {
    return mergePreferences(JSON.parse(row.preferences));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function updateNotificationPreferences(
  ctx: TenantContext,
  next: Partial<PreferenceMap>,
): Promise<PreferenceMap> {
  const current = await getNotificationPreferences(ctx);
  const merged: PreferenceMap = { ...current };
  for (const cat of CATEGORIES) {
    const incoming = next[cat];
    if (incoming) {
      merged[cat] = {
        inApp: incoming.inApp !== false,
        os: incoming.os !== false,
      };
    }
  }
  const existing = await db
    .select()
    .from(notificationPreferences)
    .where(tenantScope(ctx, notificationPreferences))
    .limit(1);
  const now = Date.now();
  const json = JSON.stringify(merged);
  if (existing[0]) {
    await db
      .update(notificationPreferences)
      .set({ preferences: json, updatedAt: now })
      .where(
        and(
          tenantScope(ctx, notificationPreferences),
          eq(notificationPreferences.id, existing[0].id),
        ),
      );
  } else {
    await db.insert(notificationPreferences).values(
      withTenantValues(ctx, {
        id: `npref_${nanoid()}`,
        preferences: json,
      }),
    );
  }
  return merged;
}

export async function createNotification(
  ctx: TenantContext,
  input: NotificationInput,
): Promise<NotificationRow | null> {
  const prefs = await getNotificationPreferences(ctx);
  const pref = prefs[input.category];
  if (!pref.inApp) {
    logger.debug({ category: input.category }, "Notification suppressed by preferences");
    return null;
  }
  // Focus-mode / Do-Not-Disturb suppression (Task #52). Approvals and
  // errors always bypass — silently dropping them would deadlock the
  // agent loop or hide real failures from the user.
  let osDispatchAllowed = pref.os;
  if (osDispatchAllowed && !focusModeBypasses(input.category)) {
    if (await isFocusModeActive(ctx)) {
      osDispatchAllowed = false;
      logger.debug(
        { category: input.category },
        "OS dispatch suppressed by focus mode",
      );
    }
  }
  const id = `ntf_${nanoid()}`;
  const dispatchedToOs = osDispatchAllowed ? 0 : 1; // 1 means "skip OS dispatch" — already accounted for
  await db.insert(notifications).values(
    withTenantValues(ctx, {
      id,
      category: input.category,
      severity: input.severity ?? "info",
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel ?? null,
      actionHref: input.actionHref ?? null,
      relatedRunId: input.relatedRunId ?? null,
      relatedApprovalId: input.relatedApprovalId ?? null,
      dispatchedToOs,
    }),
  );
  const row = await getNotification(ctx, id);
  if (!row) throw new Error("Notification missing immediately after insert");
  return row;
}

export async function getNotification(
  ctx: TenantContext,
  id: string,
): Promise<NotificationRow | null> {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(tenantScope(ctx, notifications), eq(notifications.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listNotifications(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; unreadOnly?: boolean } = {},
): Promise<PaginatedData<NotificationRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, notifications);
  const filters = [baseScope];
  if (opts.unreadOnly) filters.push(isNull(notifications.readAt));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(notifications.createdAt, cursorTs));
  }
  const where = filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getUnreadCount(ctx: TenantContext): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(notifications)
    .where(and(tenantScope(ctx, notifications), isNull(notifications.readAt)));
  return rows[0]?.value ?? 0;
}

export async function markNotificationRead(
  ctx: TenantContext,
  id: string,
): Promise<NotificationRow | null> {
  const existing = await getNotification(ctx, id);
  if (!existing) return null;
  if (existing.read) return existing;
  const now = Date.now();
  await db
    .update(notifications)
    .set({ readAt: now, updatedAt: now })
    .where(and(tenantScope(ctx, notifications), eq(notifications.id, id)));
  return getNotification(ctx, id);
}

export async function markAllRead(ctx: TenantContext): Promise<{ updated: number }> {
  const before = await getUnreadCount(ctx);
  if (before === 0) return { updated: 0 };
  const now = Date.now();
  await db
    .update(notifications)
    .set({ readAt: now, updatedAt: now })
    .where(and(tenantScope(ctx, notifications), isNull(notifications.readAt)));
  return { updated: before };
}

export async function clearAllNotifications(
  ctx: TenantContext,
): Promise<{ deleted: number }> {
  const before = await db
    .select({ value: count() })
    .from(notifications)
    .where(tenantScope(ctx, notifications));
  await db.delete(notifications).where(tenantScope(ctx, notifications));
  return { deleted: before[0]?.value ?? 0 };
}

/**
 * Atomically flip `dispatched_to_os = 1` for every undispatched row so the
 * Electron main process can fire native OS notifications without re-firing
 * the same row twice. Web-only deployments may ignore this entirely.
 */
export async function claimUndispatchedNotifications(
  ctx: TenantContext,
): Promise<NotificationRow[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(tenantScope(ctx, notifications), eq(notifications.dispatchedToOs, 0)),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  if (rows.length === 0) return [];
  const now = Date.now();
  await db
    .update(notifications)
    .set({ dispatchedToOs: 1, updatedAt: now })
    .where(
      and(tenantScope(ctx, notifications), eq(notifications.dispatchedToOs, 0)),
    );
  return rows.map(toRow);
}

