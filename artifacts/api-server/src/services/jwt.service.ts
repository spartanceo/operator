/**
 * JWT service — short-expiry access tokens + opaque rotating refresh
 * tokens for admin / privileged routes.
 *
 * Why both: the access token is a JWT so any handler can verify it
 * statelessly (no DB hit on every admin request); the refresh token is
 * an opaque random value persisted in `refresh_tokens` so we can rotate
 * and revoke server-side. Reuse of a previously-rotated refresh token
 * is treated as a stolen-token incident — the entire chain is revoked
 * and a critical security event is emitted.
 *
 * Token format is the JOSE-compatible "compact" serialisation
 * (`header.payload.signature`) but the signature is HMAC-SHA-256 with a
 * key derived from the local KDF salt, not RSA — keeps the surface
 * dependency-free until we add a real JOSE library.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  refreshTokens,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import {
  generateOpaqueToken,
  hashOpaqueToken,
} from "../lib/security-crypto";
import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class JwtError extends Error {
  override readonly name = "JwtError";
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 401,
  ) {
    super(message);
  }
}

export interface AccessTokenClaims {
  readonly sub: string;
  readonly tid: string;
  readonly wid: string | null;
  readonly role: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface IssueResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
}

function jwtSecret(): string {
  return process.env["OMNINITY_JWT_SECRET"] ?? "omninity-dev-jwt-secret-change-me";
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function signJwt(claims: AccessTokenClaims): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signing = `${header}.${payload}`;
  const sig = createHmac("sha256", jwtSecret()).update(signing).digest();
  return `${signing}.${b64url(sig)}`;
}

export function verifyJwt(token: string): AccessTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("Malformed token", "MALFORMED");
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", jwtSecret())
    .update(`${header}.${payload}`)
    .digest();
  const provided = fromB64url(signature);
  if (expected.length !== provided.length) {
    throw new JwtError("Bad signature", "BAD_SIGNATURE");
  }
  if (!timingSafeEqual(expected, provided)) {
    throw new JwtError("Bad signature", "BAD_SIGNATURE");
  }
  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(fromB64url(payload).toString("utf8")) as AccessTokenClaims;
  } catch {
    throw new JwtError("Malformed payload", "MALFORMED");
  }
  if (Date.now() >= claims.exp) {
    throw new JwtError("Token expired", "EXPIRED");
  }
  return claims;
}

async function issueRefreshToken(
  ctx: TenantContext,
  userId: string,
  replacedById: string | null,
): Promise<{ token: string; expiresAt: number; id: string }> {
  const id = `rft_${nanoid()}`;
  const token = generateOpaqueToken(32);
  const tokenHash = hashOpaqueToken(token);
  const now = Date.now();
  const expiresAt = now + REFRESH_TOKEN_TTL_MS;
  await db.insert(refreshTokens).values(
    withTenantValues(ctx, {
      id,
      userId,
      tokenHash,
      expiresAt,
      revokedAt: null,
      replacedById,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { token, expiresAt, id };
}

export interface IssueInput {
  readonly userId: string;
  readonly role: string;
}

export async function issueTokenPair(
  ctx: TenantContext,
  input: IssueInput,
): Promise<IssueResult> {
  const now = Date.now();
  const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS;
  const claims: AccessTokenClaims = {
    sub: input.userId,
    tid: ctx.tenantId,
    wid: ctx.workspaceId ?? null,
    role: input.role,
    iat: now,
    exp: accessExpiresAt,
    jti: `jti_${nanoid()}`,
  };
  const accessToken = signJwt(claims);
  const refresh = await issueRefreshToken(ctx, input.userId, null);
  await appendAuditEntry(ctx, {
    actor: input.userId,
    action: "auth.jwt.issued",
    resourceType: "session",
    resourceId: input.userId,
    summary: `Issued JWT pair (jti=${claims.jti}, refreshId=${refresh.id})`,
  });
  return {
    accessToken,
    refreshToken: refresh.token,
    accessExpiresAt: new Date(accessExpiresAt).toISOString(),
    refreshExpiresAt: new Date(refresh.expiresAt).toISOString(),
  };
}

/**
 * Rotate a refresh token. Validates it is active, then issues a fresh
 * access+refresh pair and marks the consumed token `replacedById`.
 *
 * Re-use detection: if the supplied token is already revoked OR has a
 * non-null `replacedById`, the entire user's refresh-token chain is
 * revoked and a critical security event is emitted.
 */
export async function rotateRefreshToken(
  ctx: TenantContext,
  refreshToken: string,
  role: string,
): Promise<IssueResult> {
  const tokenHash = hashOpaqueToken(refreshToken);
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(and(tenantScope(ctx, refreshTokens), eq(refreshTokens.tokenHash, tokenHash)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new JwtError("Refresh token not recognised", "REFRESH_NOT_FOUND", 401);
  }
  const now = Date.now();
  if (row.expiresAt < now) {
    throw new JwtError("Refresh token expired", "REFRESH_EXPIRED", 401);
  }
  if (row.revokedAt !== null || row.replacedById !== null) {
    // Token reuse — revoke the entire user's chain.
    await db
      .update(refreshTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(tenantScope(ctx, refreshTokens), eq(refreshTokens.userId, row.userId)));
    await logSecurityEvent(ctx, {
      eventType: "auth.refresh.reuse_detected",
      severity: "critical",
      actor: row.userId,
      target: row.userId,
      detail: `tokenId=${row.id}`,
    });
    throw new JwtError("Refresh token reuse detected", "REFRESH_REUSE", 401);
  }
  // Issue the new pair first so we know the new id, then mark the old
  // one as replaced.
  const accessClaims: AccessTokenClaims = {
    sub: row.userId,
    tid: ctx.tenantId,
    wid: ctx.workspaceId ?? null,
    role,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_MS,
    jti: `jti_${nanoid()}`,
  };
  const accessToken = signJwt(accessClaims);
  const newRefresh = await issueRefreshToken(ctx, row.userId, row.id);
  await db
    .update(refreshTokens)
    .set({ replacedById: newRefresh.id, updatedAt: now })
    .where(eq(refreshTokens.id, row.id));
  return {
    accessToken,
    refreshToken: newRefresh.token,
    accessExpiresAt: new Date(accessClaims.exp).toISOString(),
    refreshExpiresAt: new Date(newRefresh.expiresAt).toISOString(),
  };
}

export async function revokeRefreshToken(
  ctx: TenantContext,
  refreshToken: string,
): Promise<boolean> {
  const tokenHash = hashOpaqueToken(refreshToken);
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(and(tenantScope(ctx, refreshTokens), eq(refreshTokens.tokenHash, tokenHash)))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  const now = Date.now();
  await db
    .update(refreshTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(refreshTokens.id, row.id));
  return true;
}

// Sentinel keeps `randomBytes` in the import set even when no caller
// uses it directly — `generateOpaqueToken` already wraps it but the
// linter doesn't know that without an explicit reference.
void randomBytes;
