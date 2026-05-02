/**
 * Local authentication — bcryptjs password hashing + sqlite-backed
 * `sessions` table.
 *
 * Local-first means there is no third-party identity provider; the user's
 * password hash never leaves the machine. The session token is opaque
 * (nanoid) and lives in the `sessions` table — express-session's cookie
 * holds the token and the middleware loads the row on every request.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import bcrypt from "bcryptjs";

import {
  db,
  sessions,
  tenantScope,
  tenants,
  users,
  withTenantValues,
  workspaces,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "./privacy.service";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const BCRYPT_ROUNDS = 12;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  lastLoginAt: string | null;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
  sessionId: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 401,
  ) {
    super(message);
  }
}

function toUser(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt).toISOString() : null,
  };
}

/**
 * Bootstrap a brand-new tenant + owner user. Creates the tenant row first
 * so the FK on `users.tenant_id` is satisfied. Idempotent only on the
 * (tenantId, email) unique index — duplicate calls fail cleanly.
 */
export async function registerOwner(
  ctx: TenantContext,
  input: RegisterInput,
): Promise<AuthSession> {
  // Ensure the tenant + default workspace exist (the X-Tenant-ID header is
  // the tenant id; the default workspace is the FK target for every other
  // table that requires a workspaceId).
  const existingTenant = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId))
    .limit(1);
  if (existingTenant.length === 0) {
    await db.insert(tenants).values({
      id: ctx.tenantId,
      tenantId: ctx.tenantId,
      name: `Tenant ${ctx.tenantId}`,
      status: "active",
    });
  }
  const wsId = ctx.workspaceId ?? `default-${ctx.tenantId}`;
  const existingWs = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, wsId))
    .limit(1);
  if (existingWs.length === 0) {
    await db.insert(workspaces).values({
      id: wsId,
      tenantId: ctx.tenantId,
      name: "Default Workspace",
      status: "active",
    });
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const userId = `usr_${nanoid()}`;
  await db.insert(users).values(
    withTenantValues(ctx, {
      id: userId,
      email: input.email.toLowerCase(),
      passwordHash,
      displayName: input.displayName,
      role: "owner",
    }),
  );

  await logPrivacyEvent(ctx, {
    eventType: "auth.register",
    actor: userId,
    target: input.email.toLowerCase(),
    severity: "info",
  });

  return createSession(ctx, userId);
}

export async function login(ctx: TenantContext, input: LoginInput): Promise<AuthSession> {
  const rows = await db
    .select()
    .from(users)
    .where(and(tenantScope(ctx, users), eq(users.email, input.email.toLowerCase())))
    .limit(1);
  const user = rows[0];
  if (!user) {
    await logPrivacyEvent(ctx, {
      eventType: "auth.login.failed",
      actor: input.email.toLowerCase(),
      target: ctx.tenantId,
      severity: "medium",
      detail: "unknown email",
    });
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password");
  }
  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    await logPrivacyEvent(ctx, {
      eventType: "auth.login.failed",
      actor: user.id,
      target: ctx.tenantId,
      severity: "medium",
      detail: "bad password",
    });
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password");
  }

  await db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, user.id));
  await logPrivacyEvent(ctx, {
    eventType: "auth.login",
    actor: user.id,
    target: ctx.tenantId,
    severity: "info",
  });

  return createSession(ctx, user.id);
}

async function createSession(ctx: TenantContext, userId: string): Promise<AuthSession> {
  const sessionId = `ses_${nanoid()}`;
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db.insert(sessions).values(
    withTenantValues(ctx, {
      id: sessionId,
      userId,
      expiresAt,
    }),
  );
  const userRow = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return {
    user: toUser(userRow[0]!),
    expiresAt: new Date(expiresAt).toISOString(),
    sessionId,
  };
}

export async function getSession(
  ctx: TenantContext,
  sessionId: string,
): Promise<AuthSession | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(tenantScope(ctx, sessions), eq(sessions.id, sessionId)))
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  const userRow = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!userRow[0]) return null;
  return {
    user: toUser(userRow[0]),
    expiresAt: new Date(session.expiresAt).toISOString(),
    sessionId,
  };
}

export async function destroySession(
  ctx: TenantContext,
  sessionId: string,
): Promise<boolean> {
  const result = await db
    .delete(sessions)
    .where(and(tenantScope(ctx, sessions), eq(sessions.id, sessionId)));
  await logPrivacyEvent(ctx, {
    eventType: "auth.logout",
    actor: ctx.userId ?? "unknown",
    target: ctx.tenantId,
    severity: "info",
  });
  // better-sqlite3 returns { changes }; drizzle's select-style delete returns
  // void here, so we just report success — the row either existed or didn't.
  return Boolean(result);
}
