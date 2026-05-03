/**
 * Break-glass account service (Task #55).
 *
 * One emergency local-admin per enterprise org. Used ONLY when the IdP
 * is unreachable. Every successful authentication is logged as a
 * `break_glass` SSO login event AND appended to the compliance audit
 * log so a regulator can prove "who broke the glass and when".
 *
 * Password storage:
 *   - 32-char passphrase generated server-side, returned ONCE at issue.
 *   - scrypt(N=16384, r=8, p=1) with a per-account 16-byte salt.
 *   - timingSafeEqual on verification.
 *
 * Air-gap operators MUST capture the plaintext at issue time and store
 * it in their own paper safe / hardware token — the server cannot
 * recover it later.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  breakGlassAccounts,
  db,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";
import { getOrCreateOrg } from "./enterprise-admin.service";
import { recordLoginEvent } from "./sso";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN = 64;

export interface IssuedBreakGlass {
  id: string;
  email: string;
  /** Plaintext passphrase, only available at issue time. */
  passphrase: string;
  passphraseSuffix: string;
  issuedAt: string;
}

export interface BreakGlassStatus {
  exists: boolean;
  email: string | null;
  passphraseSuffix: string | null;
  status: "active" | "revoked" | null;
  issuedAt: string | null;
  lastUsedAt: string | null;
}

function hash(passphrase: string, saltB64: string): string {
  const salt = Buffer.from(saltB64, "base64");
  return scryptSync(passphrase, salt, HASH_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString("base64");
}

function generatePassphrase(): string {
  // 32-char alphanumeric. ~190 bits of entropy.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
  const buf = randomBytes(32);
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += alphabet[buf[i]! % alphabet.length];
  }
  return out;
}

/**
 * Provision (or rotate) the org's break-glass account. Returns the
 * plaintext passphrase ONCE; the caller MUST capture it.
 */
export async function provisionBreakGlass(
  ctx: TenantContext,
  reviewer: string,
  email: string,
): Promise<IssuedBreakGlass> {
  const org = await getOrCreateOrg(ctx);
  const passphrase = generatePassphrase();
  const saltB64 = randomBytes(16).toString("base64");
  const passwordHash = hash(passphrase, saltB64);
  const suffix = passphrase.slice(-4);
  const now = Date.now();
  const existing = await db
    .select()
    .from(breakGlassAccounts)
    .where(
      and(
        tenantScope(ctx, breakGlassAccounts),
        eq(breakGlassAccounts.orgId, org.id),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(breakGlassAccounts)
      .set({
        email,
        passwordHash,
        passwordSalt: saltB64,
        passphraseSuffix: suffix,
        issuedAt: now,
        status: "active",
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(eq(breakGlassAccounts.id, existing[0].id));
    await appendAuditEntry(ctx, {
      actor: reviewer,
      action: "break_glass.rotate",
      resourceType: "break_glass_account",
      resourceId: existing[0].id,
      summary: `Rotated break-glass account for ${email}`,
    });
    return {
      id: existing[0].id,
      email,
      passphrase,
      passphraseSuffix: suffix,
      issuedAt: new Date(now).toISOString(),
    };
  }
  const id = `bga_${nanoid()}`;
  await db.insert(breakGlassAccounts).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      email,
      passwordHash,
      passwordSalt: saltB64,
      passphraseSuffix: suffix,
      issuedAt: now,
      lastUsedAt: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "break_glass.provision",
    resourceType: "break_glass_account",
    resourceId: id,
    summary: `Provisioned break-glass account for ${email}`,
  });
  return {
    id,
    email,
    passphrase,
    passphraseSuffix: suffix,
    issuedAt: new Date(now).toISOString(),
  };
}

export async function getBreakGlassStatus(
  ctx: TenantContext,
): Promise<BreakGlassStatus> {
  const rows = await db
    .select()
    .from(breakGlassAccounts)
    .where(tenantScope(ctx, breakGlassAccounts))
    .limit(1);
  const r = rows[0];
  if (!r) {
    return {
      exists: false,
      email: null,
      passphraseSuffix: null,
      status: null,
      issuedAt: null,
      lastUsedAt: null,
    };
  }
  return {
    exists: true,
    email: r.email,
    passphraseSuffix: r.passphraseSuffix,
    status: (r.status === "revoked" ? "revoked" : "active") as "active" | "revoked",
    issuedAt: new Date(r.issuedAt).toISOString(),
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
  };
}

export async function revokeBreakGlass(
  ctx: TenantContext,
  reviewer: string,
): Promise<{ revoked: boolean }> {
  const now = Date.now();
  const result = await db
    .update(breakGlassAccounts)
    .set({ status: "revoked", updatedAt: now })
    .where(tenantScope(ctx, breakGlassAccounts));
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "break_glass.revoke",
    resourceType: "break_glass_account",
    summary: "Revoked break-glass account",
  });
  return { revoked: (result as unknown as { changes?: number }).changes !== 0 };
}

/**
 * Verify a break-glass authentication attempt. Always records a login
 * event (success or failure). On success, sets `lastUsedAt` and writes
 * a high-severity audit entry so the use is impossible to miss in
 * compliance review.
 */
export async function verifyBreakGlass(
  ctx: TenantContext,
  input: { email: string; passphrase: string; sourceIp?: string; userAgent?: string },
): Promise<{ ok: boolean; reason: string | null }> {
  const rows = await db
    .select()
    .from(breakGlassAccounts)
    .where(tenantScope(ctx, breakGlassAccounts))
    .limit(1);
  const r = rows[0];
  if (!r) {
    await recordLoginEvent(ctx, {
      protocol: "break_glass",
      outcome: "failure",
      email: input.email,
      failureCode: "NO_ACCOUNT",
      failureMessage: "no break-glass account provisioned",
      sourceIp: input.sourceIp ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: false, reason: "NO_ACCOUNT" };
  }
  if (r.status !== "active") {
    await recordLoginEvent(ctx, {
      protocol: "break_glass",
      outcome: "failure",
      email: input.email,
      failureCode: "REVOKED",
      sourceIp: input.sourceIp ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: false, reason: "REVOKED" };
  }
  if (r.email.toLowerCase() !== input.email.toLowerCase()) {
    await recordLoginEvent(ctx, {
      protocol: "break_glass",
      outcome: "failure",
      email: input.email,
      failureCode: "WRONG_EMAIL",
      sourceIp: input.sourceIp ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: false, reason: "WRONG_EMAIL" };
  }
  const expected = Buffer.from(r.passwordHash, "base64");
  const actual = Buffer.from(hash(input.passphrase, r.passwordSalt), "base64");
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!ok) {
    await recordLoginEvent(ctx, {
      protocol: "break_glass",
      outcome: "failure",
      email: input.email,
      failureCode: "WRONG_PASSPHRASE",
      sourceIp: input.sourceIp ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { ok: false, reason: "WRONG_PASSPHRASE" };
  }
  const now = Date.now();
  await db
    .update(breakGlassAccounts)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(breakGlassAccounts.id, r.id));
  await recordLoginEvent(ctx, {
    protocol: "break_glass",
    outcome: "success",
    email: input.email,
    sourceIp: input.sourceIp ?? null,
    userAgent: input.userAgent ?? null,
  });
  await appendAuditEntry(ctx, {
    actor: input.email,
    action: "break_glass.use",
    resourceType: "break_glass_account",
    resourceId: r.id,
    summary: `BREAK-GLASS LOGIN: ${input.email} bypassed SSO from ${input.sourceIp ?? "unknown"}`,
  });
  return { ok: true, reason: null };
}
