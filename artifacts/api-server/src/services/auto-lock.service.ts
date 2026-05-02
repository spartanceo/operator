/**
 * Auto-lock service — inactivity-based session lockout.
 *
 * The desktop shell pings `recordActivity()` every minute while the
 * user is active. `evaluateLock()` compares `lastActivityAt` to
 * `inactivityMinutes` and flips `locked = 1` when the window is
 * exceeded. Routes guarded by `auto-lock-guard.ts` short-circuit to
 * 401 LOCKED while the flag is set; the user re-enters the master
 * password to unlock.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  autoLockState,
  db,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";

export interface AutoLockStateView {
  readonly inactivityMinutes: number;
  readonly requireBiometric: boolean;
  readonly lastActivityAt: string;
  readonly locked: boolean;
}

const DEFAULT_INACTIVITY_MINUTES = 15;
const MIN_INACTIVITY_MINUTES = 1;
const MAX_INACTIVITY_MINUTES = 480;

async function readState(ctx: TenantContext) {
  const rows = await db
    .select()
    .from(autoLockState)
    .where(tenantScope(ctx, autoLockState))
    .limit(1);
  return rows[0] ?? null;
}

async function ensureState(ctx: TenantContext) {
  const existing = await readState(ctx);
  if (existing) return existing;
  const id = `alk_${nanoid()}`;
  const now = Date.now();
  await db.insert(autoLockState).values(
    withTenantValues(ctx, {
      id,
      inactivityMinutes: DEFAULT_INACTIVITY_MINUTES,
      requireBiometric: 0,
      lastActivityAt: now,
      locked: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return (await readState(ctx))!;
}

function toView(r: NonNullable<Awaited<ReturnType<typeof readState>>>): AutoLockStateView {
  return {
    inactivityMinutes: r.inactivityMinutes,
    requireBiometric: r.requireBiometric === 1,
    lastActivityAt: new Date(r.lastActivityAt).toISOString(),
    locked: r.locked === 1,
  };
}

export async function getAutoLockState(ctx: TenantContext): Promise<AutoLockStateView> {
  const row = await ensureState(ctx);
  return toView(row);
}

export async function configureAutoLock(
  ctx: TenantContext,
  input: { inactivityMinutes?: number; requireBiometric?: boolean },
): Promise<AutoLockStateView> {
  const row = await ensureState(ctx);
  const minutes =
    input.inactivityMinutes !== undefined
      ? Math.min(MAX_INACTIVITY_MINUTES, Math.max(MIN_INACTIVITY_MINUTES, input.inactivityMinutes | 0))
      : row.inactivityMinutes;
  const biometric =
    input.requireBiometric !== undefined ? (input.requireBiometric ? 1 : 0) : row.requireBiometric;
  const now = Date.now();
  await db
    .update(autoLockState)
    .set({
      inactivityMinutes: minutes,
      requireBiometric: biometric,
      updatedAt: now,
      version: row.version + 1,
    })
    .where(and(tenantScope(ctx, autoLockState), eq(autoLockState.id, row.id)));
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "auto_lock.configure",
    resourceType: "auto_lock_state",
    resourceId: ctx.tenantId,
    summary: `inactivityMinutes=${minutes} requireBiometric=${biometric === 1}`,
  });
  const refreshed = await readState(ctx);
  return toView(refreshed!);
}

export async function recordActivity(ctx: TenantContext): Promise<AutoLockStateView> {
  const row = await ensureState(ctx);
  const now = Date.now();
  await db
    .update(autoLockState)
    .set({ lastActivityAt: now, updatedAt: now, version: row.version + 1 })
    .where(and(tenantScope(ctx, autoLockState), eq(autoLockState.id, row.id)));
  const refreshed = await readState(ctx);
  return toView(refreshed!);
}

/**
 * Evaluate whether the inactivity window has elapsed and flip `locked`
 * if so. Called by the auto-lock middleware on every request; the cost
 * is one indexed read + (rarely) one update.
 */
export async function evaluateLock(
  ctx: TenantContext,
  now: number = Date.now(),
): Promise<AutoLockStateView> {
  const row = await ensureState(ctx);
  if (row.locked === 1) return toView(row);
  const elapsedMs = now - row.lastActivityAt;
  if (elapsedMs > row.inactivityMinutes * 60 * 1000) {
    await db
      .update(autoLockState)
      .set({ locked: 1, updatedAt: now, version: row.version + 1 })
      .where(and(tenantScope(ctx, autoLockState), eq(autoLockState.id, row.id)));
    await logSecurityEvent(ctx, {
      eventType: "auto_lock.engaged",
      severity: "medium",
      actor: ctx.userId ?? "system",
      target: ctx.tenantId,
      detail: `idleMinutes=${Math.floor(elapsedMs / 60000)}`,
    });
    const refreshed = await readState(ctx);
    return toView(refreshed!);
  }
  return toView(row);
}

export async function unlock(ctx: TenantContext): Promise<AutoLockStateView> {
  const row = await ensureState(ctx);
  const now = Date.now();
  await db
    .update(autoLockState)
    .set({ locked: 0, lastActivityAt: now, updatedAt: now, version: row.version + 1 })
    .where(and(tenantScope(ctx, autoLockState), eq(autoLockState.id, row.id)));
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "auto_lock.unlocked",
    resourceType: "auto_lock_state",
    resourceId: ctx.tenantId,
    summary: "Session unlocked after auto-lock",
  });
  const refreshed = await readState(ctx);
  return toView(refreshed!);
}
