/**
 * Master password service.
 *
 * The master password is the root credential that unlocks the local
 * vault on first launch. It is hashed with the scrypt KDF (Argon2id
 * stand-in until the desktop wrapper bundles a native argon2 binding —
 * the schema records `kdf_algo` so a forward migration can rotate
 * algorithms without invalidating existing hashes).
 *
 * Failure handling is rate-limited at the application layer:
 *   - 5 wrong attempts → row marked `locked_until = now + 15min`
 *   - subsequent verify calls during the lock window short-circuit to
 *     `LOCKED` without invoking the KDF.
 *
 * Biometric unlock is a flag the user toggles after the password is
 * set; the desktop shell enforces the actual Touch ID / Windows Hello
 * prompt and calls `unlockWithBiometric()` on a successful biometric
 * exchange so we never persist the plaintext password.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  masterPasswordState,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { kdfHashPassword, kdfVerifyPassword } from "../lib/security-crypto";
import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";

const MAX_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;

export class MasterPasswordError extends Error {
  override readonly name = "MasterPasswordError";
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface MasterPasswordStatus {
  readonly isSet: boolean;
  readonly biometricEnabled: boolean;
  readonly locked: boolean;
  readonly lockedUntil: string | null;
}

async function readState(ctx: TenantContext) {
  const rows = await db
    .select()
    .from(masterPasswordState)
    .where(tenantScope(ctx, masterPasswordState))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMasterPasswordStatus(
  ctx: TenantContext,
): Promise<MasterPasswordStatus> {
  const row = await readState(ctx);
  if (!row) {
    return {
      isSet: false,
      biometricEnabled: false,
      locked: false,
      lockedUntil: null,
    };
  }
  const now = Date.now();
  const locked = row.lockedUntil !== null && row.lockedUntil > now;
  return {
    isSet: true,
    biometricEnabled: row.biometricEnabled === 1,
    locked,
    lockedUntil: row.lockedUntil ? new Date(row.lockedUntil).toISOString() : null,
  };
}

/**
 * Set or replace the master password. Replacing requires the caller to
 * have already proven knowledge of the old one (the route handler
 * verifies first and then calls this with `{ replace: true }`).
 */
export async function setMasterPassword(
  ctx: TenantContext,
  plaintext: string,
): Promise<MasterPasswordStatus> {
  if (typeof plaintext !== "string" || plaintext.length < MIN_PASSWORD_LENGTH) {
    throw new MasterPasswordError(
      `Master password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      "PASSWORD_WEAK",
      400,
    );
  }
  const existing = await readState(ctx);
  const kdf = kdfHashPassword(plaintext);
  const now = Date.now();
  if (existing) {
    await db
      .update(masterPasswordState)
      .set({
        kdfHash: kdf.hash,
        kdfSalt: kdf.salt,
        kdfAlgo: kdf.algo,
        failedAttempts: 0,
        lockedUntil: null,
        setAt: now,
        updatedAt: now,
        version: existing.version + 1,
      })
      .where(and(tenantScope(ctx, masterPasswordState), eq(masterPasswordState.id, existing.id)));
  } else {
    await db.insert(masterPasswordState).values(
      withTenantValues(ctx, {
        id: `mpw_${nanoid()}`,
        kdfHash: kdf.hash,
        kdfSalt: kdf.salt,
        kdfAlgo: kdf.algo,
        biometricEnabled: 0,
        failedAttempts: 0,
        lockedUntil: null,
        setAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "system",
    action: existing ? "master_password.rotated" : "master_password.set",
    resourceType: "master_password",
    resourceId: ctx.tenantId,
    summary: existing ? "Master password rotated" : "Master password set",
  });
  return getMasterPasswordStatus(ctx);
}

export interface VerifyResult {
  readonly success: boolean;
  readonly locked: boolean;
  readonly remainingAttempts: number;
}

export async function verifyMasterPassword(
  ctx: TenantContext,
  plaintext: string,
): Promise<VerifyResult> {
  const row = await readState(ctx);
  if (!row) {
    throw new MasterPasswordError("Master password is not set", "NOT_SET", 404);
  }
  const now = Date.now();
  if (row.lockedUntil !== null && row.lockedUntil > now) {
    await logSecurityEvent(ctx, {
      eventType: "master_password.verify.locked",
      severity: "high",
      actor: ctx.userId ?? "anonymous",
      target: ctx.tenantId,
    });
    return {
      success: false,
      locked: true,
      remainingAttempts: 0,
    };
  }
  const ok = kdfVerifyPassword(plaintext, {
    algo: row.kdfAlgo,
    salt: row.kdfSalt,
    hash: row.kdfHash,
  });
  if (ok) {
    await db
      .update(masterPasswordState)
      .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now, version: row.version + 1 })
      .where(and(tenantScope(ctx, masterPasswordState), eq(masterPasswordState.id, row.id)));
    await logSecurityEvent(ctx, {
      eventType: "master_password.verify.success",
      severity: "info",
      actor: ctx.userId ?? "anonymous",
      target: ctx.tenantId,
    });
    return { success: true, locked: false, remainingAttempts: MAX_ATTEMPTS };
  }
  const nextAttempts = row.failedAttempts + 1;
  const willLock = nextAttempts >= MAX_ATTEMPTS;
  await db
    .update(masterPasswordState)
    .set({
      failedAttempts: willLock ? 0 : nextAttempts,
      lockedUntil: willLock ? now + LOCK_WINDOW_MS : null,
      updatedAt: now,
      version: row.version + 1,
    })
    .where(and(tenantScope(ctx, masterPasswordState), eq(masterPasswordState.id, row.id)));
  await logSecurityEvent(ctx, {
    eventType: willLock ? "master_password.verify.locked_out" : "master_password.verify.fail",
    severity: willLock ? "critical" : "medium",
    actor: ctx.userId ?? "anonymous",
    target: ctx.tenantId,
    detail: `attempts=${nextAttempts}`,
  });
  return {
    success: false,
    locked: willLock,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS - nextAttempts),
  };
}

export async function setBiometricEnabled(
  ctx: TenantContext,
  enabled: boolean,
): Promise<MasterPasswordStatus> {
  const row = await readState(ctx);
  if (!row) {
    throw new MasterPasswordError(
      "Cannot enable biometric unlock until a master password is set",
      "NOT_SET",
      404,
    );
  }
  await db
    .update(masterPasswordState)
    .set({
      biometricEnabled: enabled ? 1 : 0,
      updatedAt: Date.now(),
      version: row.version + 1,
    })
    .where(and(tenantScope(ctx, masterPasswordState), eq(masterPasswordState.id, row.id)));
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "system",
    action: enabled ? "master_password.biometric.enabled" : "master_password.biometric.disabled",
    resourceType: "master_password",
    resourceId: ctx.tenantId,
    summary: enabled ? "Biometric unlock enabled" : "Biometric unlock disabled",
  });
  return getMasterPasswordStatus(ctx);
}

/**
 * Hook used by the desktop wrapper after a successful Touch ID / Windows
 * Hello prompt. We trust the wrapper because the prompt itself happened
 * inside the OS — the wrapper just calls this to mark the session as
 * unlocked so subsequent vault reads work without re-prompting.
 *
 * In server-only environments (no desktop wrapper) this is a no-op
 * stub — the wrapper integration ticket plugs in the real bridge.
 */
export async function unlockWithBiometric(ctx: TenantContext): Promise<MasterPasswordStatus> {
  const status = await getMasterPasswordStatus(ctx);
  if (!status.biometricEnabled) {
    throw new MasterPasswordError(
      "Biometric unlock is not enabled",
      "BIOMETRIC_DISABLED",
      400,
    );
  }
  await logSecurityEvent(ctx, {
    eventType: "master_password.biometric.unlock",
    severity: "info",
    actor: ctx.userId ?? "anonymous",
    target: ctx.tenantId,
  });
  return status;
}
