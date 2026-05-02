/**
 * Web Push subscription registry for the Mobile Companion PWA.
 *
 * Tier 1 stores subscriptions only — the actual VAPID-signed payload
 * delivery happens out of band (and is stubbed in dev). Subscriptions are
 * deduped by `(deviceId, endpoint)` so re-registering on PWA reload does
 * not balloon the table.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  mobileNotificationPrefs,
  mobilePushSubscriptions,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionRow {
  id: string;
  deviceId: string;
  endpoint: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPrefsRow {
  taskCompleted: boolean;
  approvalNeeded: boolean;
  taskFailed: boolean;
  longTaskProgress: boolean;
  updatedAt: string;
}

export async function registerPushSubscription(
  ctx: TenantContext,
  deviceId: string,
  input: PushSubscriptionInput,
): Promise<PushSubscriptionRow> {
  const existing = await db
    .select()
    .from(mobilePushSubscriptions)
    .where(
      and(
        tenantScope(ctx, mobilePushSubscriptions),
        eq(mobilePushSubscriptions.deviceId, deviceId),
        eq(mobilePushSubscriptions.endpoint, input.endpoint),
      ),
    )
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    await db
      .update(mobilePushSubscriptions)
      .set({
        p256dh: input.p256dh,
        auth: input.auth,
        updatedAt: now,
      })
      .where(eq(mobilePushSubscriptions.id, existing[0].id));
    const r = existing[0];
    return {
      id: r.id,
      deviceId: r.deviceId,
      endpoint: r.endpoint,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  }
  const id = `mps_${nanoid()}`;
  await db.insert(mobilePushSubscriptions).values(
    withTenantValues(ctx, {
      id,
      deviceId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    }),
  );
  return {
    id,
    deviceId,
    endpoint: input.endpoint,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

const DEFAULT_PREFS: NotificationPrefsRow = {
  taskCompleted: true,
  approvalNeeded: true,
  taskFailed: true,
  longTaskProgress: true,
  updatedAt: new Date(0).toISOString(),
};

export async function getNotificationPrefs(
  ctx: TenantContext,
): Promise<NotificationPrefsRow> {
  const rows = await db
    .select()
    .from(mobileNotificationPrefs)
    .where(tenantScope(ctx, mobileNotificationPrefs))
    .limit(1);
  const r = rows[0];
  if (!r) return DEFAULT_PREFS;
  return {
    taskCompleted: r.taskCompleted === 1,
    approvalNeeded: r.approvalNeeded === 1,
    taskFailed: r.taskFailed === 1,
    longTaskProgress: r.longTaskProgress === 1,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function setNotificationPrefs(
  ctx: TenantContext,
  prefs: Partial<Omit<NotificationPrefsRow, "updatedAt">>,
): Promise<NotificationPrefsRow> {
  const existing = await db
    .select()
    .from(mobileNotificationPrefs)
    .where(tenantScope(ctx, mobileNotificationPrefs))
    .limit(1);
  const now = Date.now();
  const merged = {
    taskCompleted: prefs.taskCompleted ?? (existing[0] ? existing[0].taskCompleted === 1 : true),
    approvalNeeded: prefs.approvalNeeded ?? (existing[0] ? existing[0].approvalNeeded === 1 : true),
    taskFailed: prefs.taskFailed ?? (existing[0] ? existing[0].taskFailed === 1 : true),
    longTaskProgress: prefs.longTaskProgress ?? (existing[0] ? existing[0].longTaskProgress === 1 : true),
  };
  if (existing[0]) {
    await db
      .update(mobileNotificationPrefs)
      .set({
        taskCompleted: merged.taskCompleted ? 1 : 0,
        approvalNeeded: merged.approvalNeeded ? 1 : 0,
        taskFailed: merged.taskFailed ? 1 : 0,
        longTaskProgress: merged.longTaskProgress ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(mobileNotificationPrefs.id, existing[0].id));
  } else {
    await db.insert(mobileNotificationPrefs).values(
      withTenantValues(ctx, {
        id: `mnp_${nanoid()}`,
        taskCompleted: merged.taskCompleted ? 1 : 0,
        approvalNeeded: merged.approvalNeeded ? 1 : 0,
        taskFailed: merged.taskFailed ? 1 : 0,
        longTaskProgress: merged.longTaskProgress ? 1 : 0,
      }),
    );
  }
  return { ...merged, updatedAt: new Date(now).toISOString() };
}
