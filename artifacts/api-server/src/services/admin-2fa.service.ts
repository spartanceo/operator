/**
 * Admin 2FA service — RFC 6238 TOTP for super-admin accounts.
 *
 * Flow:
 *   1. setup()    issues a fresh secret, persists `confirmed = 0`.
 *   2. confirm()  takes the user's first valid code and flips
 *                 `confirmed = 1`. Until then the secret is provisional.
 *   3. verify()   checks any subsequent code; rejects re-use of the
 *                 same counter (`lastUsedCounter >= matched counter`).
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  admin2faSecrets,
  db,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { generateTotpSecret, totpVerify } from "../lib/security-crypto";
import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";

export class AdminTwoFactorError extends Error {
  override readonly name = "AdminTwoFactorError";
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface AdminTwoFactorSetup {
  readonly secret: string;
  readonly otpauthUri: string;
}

async function readRow(ctx: TenantContext, userId: string) {
  const rows = await db
    .select()
    .from(admin2faSecrets)
    .where(and(tenantScope(ctx, admin2faSecrets), eq(admin2faSecrets.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function setup2fa(
  ctx: TenantContext,
  userId: string,
  accountLabel: string,
): Promise<AdminTwoFactorSetup> {
  const secret = generateTotpSecret(20);
  const existing = await readRow(ctx, userId);
  const now = Date.now();
  if (existing) {
    if (existing.confirmed === 1) {
      throw new AdminTwoFactorError(
        "2FA is already confirmed for this user; revoke it first",
        "ALREADY_CONFIRMED",
        409,
      );
    }
    await db
      .update(admin2faSecrets)
      .set({
        secretBase32: secret,
        lastUsedCounter: null,
        updatedAt: now,
        version: existing.version + 1,
      })
      .where(eq(admin2faSecrets.id, existing.id));
  } else {
    await db.insert(admin2faSecrets).values(
      withTenantValues(ctx, {
        id: `t2f_${nanoid()}`,
        userId,
        secretBase32: secret,
        confirmed: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  const issuer = encodeURIComponent("Omninity Operator");
  const account = encodeURIComponent(accountLabel);
  const otpauthUri = `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  return { secret, otpauthUri };
}

export async function confirm2fa(
  ctx: TenantContext,
  userId: string,
  code: string,
): Promise<{ confirmed: boolean }> {
  const row = await readRow(ctx, userId);
  if (!row) {
    throw new AdminTwoFactorError("2FA setup has not been started", "NOT_FOUND", 404);
  }
  if (row.confirmed === 1) return { confirmed: true };
  const result = totpVerify(row.secretBase32, code);
  if (!result.valid) {
    await logSecurityEvent(ctx, {
      eventType: "admin_2fa.confirm.fail",
      severity: "high",
      actor: userId,
      target: userId,
    });
    throw new AdminTwoFactorError("Invalid 2FA code", "INVALID_CODE", 401);
  }
  await db
    .update(admin2faSecrets)
    .set({
      confirmed: 1,
      lastUsedCounter: result.counter,
      updatedAt: Date.now(),
      version: row.version + 1,
    })
    .where(eq(admin2faSecrets.id, row.id));
  await appendAuditEntry(ctx, {
    actor: userId,
    action: "admin_2fa.confirmed",
    resourceType: "admin_2fa",
    resourceId: userId,
    summary: "Admin TOTP confirmed",
  });
  return { confirmed: true };
}

export async function verify2fa(
  ctx: TenantContext,
  userId: string,
  code: string,
): Promise<{ success: boolean }> {
  const row = await readRow(ctx, userId);
  if (!row || row.confirmed !== 1) {
    throw new AdminTwoFactorError("2FA is not configured", "NOT_CONFIGURED", 404);
  }
  const result = totpVerify(row.secretBase32, code);
  if (!result.valid || result.counter === null) {
    await logSecurityEvent(ctx, {
      eventType: "admin_2fa.verify.fail",
      severity: "high",
      actor: userId,
      target: userId,
    });
    return { success: false };
  }
  if (row.lastUsedCounter !== null && result.counter <= row.lastUsedCounter) {
    // Replay attack — same counter, already used.
    await logSecurityEvent(ctx, {
      eventType: "admin_2fa.verify.replay",
      severity: "critical",
      actor: userId,
      target: userId,
      detail: `counter=${result.counter}`,
    });
    return { success: false };
  }
  await db
    .update(admin2faSecrets)
    .set({
      lastUsedCounter: result.counter,
      updatedAt: Date.now(),
      version: row.version + 1,
    })
    .where(eq(admin2faSecrets.id, row.id));
  return { success: true };
}

export async function revoke2fa(ctx: TenantContext, userId: string): Promise<void> {
  const row = await readRow(ctx, userId);
  if (!row) return;
  await db.delete(admin2faSecrets).where(eq(admin2faSecrets.id, row.id));
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "system",
    action: "admin_2fa.revoked",
    resourceType: "admin_2fa",
    resourceId: userId,
    summary: "Admin TOTP revoked",
  });
}
