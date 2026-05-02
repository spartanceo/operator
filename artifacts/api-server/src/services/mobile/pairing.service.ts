/**
 * Mobile pairing service — QR-code handshake between the desktop OP and
 * the Mobile Companion PWA.
 *
 * Tier 1 stores the relay token hash on the `paired_devices` row. The
 * token returned to the PWA is the only place the cleartext exists; the
 * desktop never sees it again. A future hardening pass swaps SHA-256 for
 * Argon2id; the column shape stays the same.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  pairedDevices,
  pairingTokens,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { ensureTenantWorkspace } from "../../lib/tenant-ensure";
import { logPrivacyEvent } from "../privacy.service";

export interface PairingTokenRow {
  id: string;
  code: string;
  expiresAt: string;
  createdAt: string;
  /** Cleartext relay token returned ONLY at create time. */
  relayToken?: string;
  qrPayload?: string;
}

export interface PairedDeviceRow {
  id: string;
  label: string;
  platform: string;
  userAgent: string | null;
  status: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ClaimPairingInput {
  code: string;
  label: string;
  platform: string;
  userAgent?: string;
}

export interface ClaimPairingResult {
  device: PairedDeviceRow;
  /** Long-lived bearer token the PWA stores; presented on every request. */
  relayToken: string;
}

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateCode(): string {
  // 8-digit numeric pairing code — easy to type if QR scan fails.
  return String(randomInt(10_000_000, 100_000_000));
}

function generateRelayToken(): string {
  return `mrt_${randomBytes(24).toString("base64url")}`;
}

function toDeviceRow(r: typeof pairedDevices.$inferSelect): PairedDeviceRow {
  return {
    id: r.id,
    label: r.label,
    platform: r.platform,
    userAgent: r.userAgent,
    status: r.status,
    pairedAt: new Date(r.pairedAt).toISOString(),
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
    revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/**
 * Generate a fresh pairing token. Returns the cleartext relay token —
 * the desktop UI embeds it in the QR payload and the PWA pulls it on scan.
 */
export async function startPairing(
  ctx: TenantContext,
): Promise<PairingTokenRow> {
  await ensureTenantWorkspace(ctx);
  const id = `ptk_${nanoid()}`;
  const code = generateCode();
  const relayToken = generateRelayToken();
  const expiresAt = Date.now() + PAIRING_TOKEN_TTL_MS;
  await db.insert(pairingTokens).values(
    withTenantValues(ctx, {
      id,
      code,
      relayTokenHash: hashToken(relayToken),
      expiresAt,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "mobile.pairing.started",
    actor: "user",
    target: id,
    severity: "low",
    detail: "Generated mobile pairing QR code",
  });
  // QR payload encodes everything the PWA needs to call /pairing/claim.
  const qrPayload = JSON.stringify({
    v: 1,
    code,
    token: relayToken,
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    expiresAt,
  });
  return {
    id,
    code,
    expiresAt: new Date(expiresAt).toISOString(),
    createdAt: new Date().toISOString(),
    relayToken,
    qrPayload,
  };
}

export async function claimPairing(
  ctx: TenantContext,
  input: ClaimPairingInput,
  presentedRelayToken: string,
): Promise<ClaimPairingResult> {
  const now = Date.now();
  const rows = await db
    .select()
    .from(pairingTokens)
    .where(
      and(
        tenantScope(ctx, pairingTokens),
        eq(pairingTokens.code, input.code),
        gt(pairingTokens.expiresAt, now),
        isNull(pairingTokens.claimedAt),
      ),
    )
    .limit(1);
  const token = rows[0];
  if (!token) {
    throw new PairingError("Pairing code is unknown, expired, or already used");
  }
  if (token.relayTokenHash !== hashToken(presentedRelayToken)) {
    throw new PairingError("Pairing token mismatch");
  }
  const deviceId = `pdv_${nanoid()}`;
  await db.insert(pairedDevices).values(
    withTenantValues(ctx, {
      id: deviceId,
      label: input.label.slice(0, 200),
      platform: input.platform.slice(0, 40),
      userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
      tokenHash: token.relayTokenHash,
      status: "active" as const,
      pairedAt: now,
      lastSeenAt: now,
    }),
  );
  await db
    .update(pairingTokens)
    .set({ claimedAt: now, deviceId })
    .where(and(tenantScope(ctx, pairingTokens), eq(pairingTokens.id, token.id)));
  await logPrivacyEvent(ctx, {
    eventType: "mobile.device.paired",
    actor: "user",
    target: `${deviceId}:${input.label}`,
    severity: "medium",
    detail: `Paired mobile device "${input.label}" (${input.platform})`,
  });
  const device = await getDevice(ctx, deviceId);
  if (!device) throw new Error("Device missing immediately after insert");
  return { device, relayToken: presentedRelayToken };
}

export async function listDevices(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<PairedDeviceRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, pairedDevices);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(pairedDevices.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(pairedDevices)
    .where(where)
    .orderBy(desc(pairedDevices.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toDeviceRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getDevice(
  ctx: TenantContext,
  id: string,
): Promise<PairedDeviceRow | null> {
  const rows = await db
    .select()
    .from(pairedDevices)
    .where(and(tenantScope(ctx, pairedDevices), eq(pairedDevices.id, id)))
    .limit(1);
  return rows[0] ? toDeviceRow(rows[0]) : null;
}

export async function revokeDevice(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; revoked: boolean }> {
  const existing = await getDevice(ctx, id);
  if (!existing) return { id, revoked: false };
  const now = Date.now();
  await db
    .update(pairedDevices)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(and(tenantScope(ctx, pairedDevices), eq(pairedDevices.id, id)));
  await logPrivacyEvent(ctx, {
    eventType: "mobile.device.revoked",
    actor: "user",
    target: `${id}:${existing.label}`,
    severity: "medium",
    detail: `Revoked mobile device "${existing.label}"`,
  });
  return { id, revoked: true };
}

export async function heartbeatDevice(
  ctx: TenantContext,
  id: string,
): Promise<PairedDeviceRow | null> {
  const existing = await getDevice(ctx, id);
  if (!existing || existing.status !== "active") return existing;
  const now = Date.now();
  await db
    .update(pairedDevices)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(and(tenantScope(ctx, pairedDevices), eq(pairedDevices.id, id)));
  return getDevice(ctx, id);
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}
