/**
 * Integrations service — install, list, test, and execute third-party
 * connectors.
 *
 * Storage shape: one row per (tenant, provider). Credentials are encrypted
 * via `credential-crypto` (AES-256-GCM) before being written and never
 * returned to the client in plaintext — `redactCredentials` from the
 * provider registry replaces secret fields with the literal "set"/"unset"
 * markers.
 *
 * OAuth note: real OAuth flows require a callback URL on a public host.
 * Tier 1 ships a deterministic stub that returns a synthetic authorise URL
 * the UI can preview, and a callback that simply records the supplied code
 * as the access token after encrypting it. That keeps the entire flow
 * exercisable end-to-end (including audit log and tool-registry wiring)
 * without depending on any external network.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  integrations,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import {
  decryptCredentials,
  encryptCredentials,
} from "../lib/credential-crypto";
import { logger } from "../lib/logger";
import {
  getProviderOrThrow,
  type ProviderDescriptor,
  redactCredentials,
} from "./integration-registry";
import { logPrivacyEvent } from "./privacy.service";

export type ConnectionStatus = "disconnected" | "connected" | "error";

export interface IntegrationRow {
  id: string;
  provider: string;
  displayName: string;
  authType: string;
  connectionStatus: ConnectionStatus;
  accountLabel: string | null;
  credentials: Record<string, "set" | "unset" | unknown>;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectInput {
  credentials: Record<string, unknown>;
  accountLabel?: string;
}

export interface OAuthStartResult {
  provider: string;
  authorizeUrl: string;
  state: string;
  scopes: readonly string[];
}

export interface OAuthCallbackInput {
  code: string;
  state?: string;
  refreshToken?: string;
  accountLabel?: string;
}

export interface IntegrationActionResult {
  provider: string;
  action: string;
  simulated: true;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export class IntegrationNotConnectedError extends Error {
  override readonly name = "IntegrationNotConnectedError";
  readonly code = "NOT_CONNECTED";
  constructor(provider: string) {
    super(`Integration "${provider}" is not connected`);
  }
}

export class UnknownProviderError extends Error {
  override readonly name = "UnknownProviderError";
  readonly code = "UNKNOWN_PROVIDER";
  constructor(provider: string) {
    super(`Unknown integration provider "${provider}"`);
  }
}

export class UnknownActionError extends Error {
  override readonly name = "UnknownActionError";
  readonly code = "UNKNOWN_ACTION";
  constructor(provider: string, action: string) {
    super(`Unknown action "${action}" for provider "${provider}"`);
  }
}

function rowToIntegration(
  provider: ProviderDescriptor,
  r: typeof integrations.$inferSelect,
): IntegrationRow {
  let creds: Record<string, unknown> | null = null;
  try {
    creds = decryptCredentials(r.credentialsEncrypted);
  } catch (e) {
    logger.error(
      { err: e, provider: r.provider },
      "Failed to decrypt integration credentials",
    );
  }
  return {
    id: r.id,
    provider: r.provider,
    displayName: r.displayName,
    authType: r.authType,
    connectionStatus: r.connectionStatus as ConnectionStatus,
    accountLabel: r.accountLabel,
    credentials: redactCredentials(provider, creds),
    lastTestedAt: r.lastTestedAt
      ? new Date(r.lastTestedAt).toISOString()
      : null,
    lastError: r.lastError,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function disconnectedShape(provider: ProviderDescriptor): IntegrationRow {
  return {
    id: "",
    provider: provider.id,
    displayName: provider.label,
    authType: provider.authType,
    connectionStatus: "disconnected",
    accountLabel: null,
    credentials: redactCredentials(provider, null),
    lastTestedAt: null,
    lastError: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

export async function listIntegrations(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<IntegrationRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, integrations);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(integrations.createdAt, cursorTs))
      : baseScope;

  const rows = await db
    .select()
    .from(integrations)
    .where(where)
    .orderBy(desc(integrations.createdAt))
    .limit(limit + 1);

  const items = rows.map((r) => {
    const provider = getProviderOrThrow(r.provider);
    return rowToIntegration(provider, r);
  });

  return buildPage(items, limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getIntegration(
  ctx: TenantContext,
  providerId: string,
): Promise<IntegrationRow> {
  const provider = getProviderOrThrow(providerId);
  const rows = await db
    .select()
    .from(integrations)
    .where(
      and(
        tenantScope(ctx, integrations),
        eq(integrations.provider, providerId),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return disconnectedShape(provider);
  return rowToIntegration(provider, r);
}

function validateCredentials(
  provider: ProviderDescriptor,
  creds: Record<string, unknown>,
): void {
  for (const f of provider.fields) {
    if (f.required && (creds[f.name] === undefined || creds[f.name] === "")) {
      const err = new Error(
        `Missing required field "${f.name}" for provider "${provider.id}"`,
      );
      (err as Error & { code?: string }).code = "VALIDATION";
      throw err;
    }
  }
}

async function upsertIntegration(
  ctx: TenantContext,
  provider: ProviderDescriptor,
  patch: {
    credentials: Record<string, unknown>;
    accountLabel?: string | null;
    connectionStatus: ConnectionStatus;
    lastError?: string | null;
    lastTestedAt?: number | null;
  },
): Promise<IntegrationRow> {
  const encrypted = encryptCredentials(patch.credentials);
  const now = Date.now();

  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(integrations)
      .where(
        and(
          tenantScope(ctx, integrations),
          eq(integrations.provider, provider.id),
        ),
      )
      .limit(1)
      .all();

    if (existing.length === 0) {
      const id = `int_${nanoid()}`;
      tx.insert(integrations)
        .values(
          withTenantValues(ctx, {
            id,
            provider: provider.id,
            displayName: provider.label,
            authType: provider.authType,
            connectionStatus: patch.connectionStatus,
            credentialsEncrypted: encrypted,
            accountLabel: patch.accountLabel ?? null,
            lastTestedAt: patch.lastTestedAt ?? null,
            lastError: patch.lastError ?? null,
            createdAt: now,
            updatedAt: now,
            version: 1,
          }),
        )
        .run();
    } else {
      const prev = existing[0]!;
      tx.update(integrations)
        .set({
          displayName: provider.label,
          authType: provider.authType,
          connectionStatus: patch.connectionStatus,
          credentialsEncrypted: encrypted,
          accountLabel:
            patch.accountLabel !== undefined
              ? patch.accountLabel
              : prev.accountLabel,
          lastTestedAt: patch.lastTestedAt ?? prev.lastTestedAt,
          lastError: patch.lastError ?? null,
          updatedAt: now,
          version: prev.version + 1,
        })
        .where(
          and(
            tenantScope(ctx, integrations),
            eq(integrations.provider, provider.id),
          ),
        )
        .run();
    }

    const after = tx
      .select()
      .from(integrations)
      .where(
        and(
          tenantScope(ctx, integrations),
          eq(integrations.provider, provider.id),
        ),
      )
      .limit(1)
      .all();
    if (!after[0]) throw new Error("integration not found after upsert");
    return after[0];
  });

  return rowToIntegration(provider, result);
}

export async function connectIntegration(
  ctx: TenantContext,
  providerId: string,
  input: ConnectInput,
): Promise<IntegrationRow> {
  const provider = getProviderOrThrow(providerId);
  validateCredentials(provider, input.credentials);
  const row = await upsertIntegration(ctx, provider, {
    credentials: input.credentials,
    accountLabel: input.accountLabel ?? null,
    connectionStatus: "connected",
    lastError: null,
    lastTestedAt: Date.now(),
  });
  await logPrivacyEvent(ctx, {
    eventType: "integration.connect",
    actor: ctx.userId ?? ctx.tenantId,
    target: providerId,
    severity: "medium",
    detail: input.accountLabel ?? undefined,
  });
  return row;
}

export async function disconnectIntegration(
  ctx: TenantContext,
  providerId: string,
): Promise<{ provider: string; deleted: boolean }> {
  const provider = getProviderOrThrow(providerId);
  const result = await db
    .delete(integrations)
    .where(
      and(
        tenantScope(ctx, integrations),
        eq(integrations.provider, provider.id),
      ),
    );
  const deleted = (result as { changes?: number }).changes
    ? (result as { changes: number }).changes > 0
    : true;
  await logPrivacyEvent(ctx, {
    eventType: "integration.disconnect",
    actor: ctx.userId ?? ctx.tenantId,
    target: providerId,
    severity: "low",
  });
  return { provider: providerId, deleted };
}

/**
 * Verify the stored credentials. Tier 1 contract: a connection is
 * considered "healthy" if every required credential field is present
 * after decryption. Real adapters will replace this with a provider
 * ping (e.g. `GET /me`) once the OAuth pipeline is live.
 */
export async function testIntegration(
  ctx: TenantContext,
  providerId: string,
): Promise<IntegrationRow> {
  const provider = getProviderOrThrow(providerId);
  const rows = await db
    .select()
    .from(integrations)
    .where(
      and(
        tenantScope(ctx, integrations),
        eq(integrations.provider, provider.id),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    throw new IntegrationNotConnectedError(providerId);
  }
  const creds = decryptCredentials(existing.credentialsEncrypted);
  let status: ConnectionStatus = "connected";
  let lastError: string | null = null;
  for (const f of provider.fields) {
    if (f.required && (!creds || !creds[f.name])) {
      status = "error";
      lastError = `Missing required credential "${f.name}"`;
      break;
    }
  }

  await db
    .update(integrations)
    .set({
      connectionStatus: status,
      lastTestedAt: Date.now(),
      lastError,
      updatedAt: Date.now(),
      version: existing.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, integrations),
        eq(integrations.provider, provider.id),
      ),
    );

  await logPrivacyEvent(ctx, {
    eventType: "integration.test",
    actor: ctx.userId ?? ctx.tenantId,
    target: providerId,
    severity: status === "connected" ? "info" : "medium",
    detail: lastError ?? undefined,
  });

  return getIntegration(ctx, providerId);
}

export function buildOAuthStart(
  ctx: TenantContext,
  providerId: string,
  redirectUri?: string,
): OAuthStartResult {
  const provider = getProviderOrThrow(providerId);
  if (provider.authType !== "oauth") {
    const err = new Error(`Provider "${providerId}" does not use OAuth`);
    (err as Error & { code?: string }).code = "VALIDATION";
    throw err;
  }
  const state = `oauth_${nanoid()}`;
  // Tier 1 stub: a deterministic local URL the UI can render so the user
  // can see exactly which scopes will be requested. Real adapters swap in
  // the provider's authorize endpoint.
  const params = new URLSearchParams({
    response_type: "code",
    state,
    scope: provider.oauthScopes.join(" "),
    tenant: ctx.tenantId,
  });
  if (redirectUri) params.set("redirect_uri", redirectUri);
  return {
    provider: providerId,
    authorizeUrl: `omninity://oauth/${providerId}/authorize?${params.toString()}`,
    state,
    scopes: provider.oauthScopes,
  };
}

export async function completeOAuthCallback(
  ctx: TenantContext,
  providerId: string,
  input: OAuthCallbackInput,
): Promise<IntegrationRow> {
  const provider = getProviderOrThrow(providerId);
  if (provider.authType !== "oauth") {
    const err = new Error(`Provider "${providerId}" does not use OAuth`);
    (err as Error & { code?: string }).code = "VALIDATION";
    throw err;
  }
  // Tier 1: persist the supplied code as the access token. Real adapters
  // will exchange the code at the provider's token endpoint and store the
  // returned access/refresh pair instead.
  const credentials: Record<string, unknown> = { accessToken: input.code };
  if (input.refreshToken) credentials["refreshToken"] = input.refreshToken;
  const row = await upsertIntegration(ctx, provider, {
    credentials,
    accountLabel: input.accountLabel ?? null,
    connectionStatus: "connected",
    lastError: null,
    lastTestedAt: Date.now(),
  });
  await logPrivacyEvent(ctx, {
    eventType: "integration.oauth_callback",
    actor: ctx.userId ?? ctx.tenantId,
    target: providerId,
    severity: "medium",
  });
  return row;
}

/**
 * Resolve the decrypted credentials for a connected provider, or return null
 * when the tenant has no active connection for that provider.
 *
 * This is the **standard lookup** for all provider-backed tool handlers.
 * Example usage in a tool handler:
 *
 *   const creds = await getConnectedProvider(ctx, "brave_search");
 *   if (!creds) { return { error: "no search provider connected" }; }
 *   const apiKey = creds["apiKey"] as string;
 *
 * Always prefer this over reading process.env directly — it keeps credentials
 * per-tenant and avoids leaking a shared server key to all customers.
 */
export async function getConnectedProvider(
  ctx: TenantContext,
  providerId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(integrations)
    .where(
      and(
        tenantScope(ctx, integrations),
        eq(integrations.provider, providerId),
        eq(integrations.connectionStatus, "connected"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return decryptCredentials(row.credentialsEncrypted);
  } catch (e) {
    logger.warn(
      { err: e, provider: providerId },
      "getConnectedProvider: failed to decrypt credentials — treating as disconnected",
    );
    return null;
  }
}

/**
 * Execute one provider action. Tier 1 returns a deterministic
 * `simulated: true` envelope so agent plans, the audit log, and the UI
 * can be tested without real third-party access.
 */
export async function executeIntegrationAction(
  ctx: TenantContext,
  providerId: string,
  actionName: string,
  input: Record<string, unknown>,
): Promise<IntegrationActionResult> {
  const provider = getProviderOrThrow(providerId);
  const action = provider.actions.find((a) => a.name === actionName);
  if (!action) throw new UnknownActionError(providerId, actionName);

  const rows = await db
    .select()
    .from(integrations)
    .where(
      and(
        tenantScope(ctx, integrations),
        eq(integrations.provider, provider.id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.connectionStatus !== "connected") {
    throw new IntegrationNotConnectedError(providerId);
  }

  await logPrivacyEvent(ctx, {
    eventType: "integration.action",
    actor: ctx.userId ?? ctx.tenantId,
    target: `${providerId}.${actionName}`,
    severity: action.riskLevel === "low" ? "info" : "medium",
    detail: JSON.stringify({ keys: Object.keys(input) }),
  });

  return {
    provider: providerId,
    action: actionName,
    simulated: true,
    input,
    output: {
      message: `Tier 1 stub for ${providerId}.${actionName}`,
      riskLevel: action.riskLevel,
      runAt: new Date().toISOString(),
    },
  };
}
