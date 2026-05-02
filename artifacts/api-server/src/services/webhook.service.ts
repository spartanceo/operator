/**
 * Webhook secrets / HMAC service.
 *
 * Standard 12 § "Webhook integrity": every inbound webhook (Stripe,
 * Resend, custom) carries an HMAC signature of the raw request body
 * computed with the per-endpoint secret stored here. The verify call
 * is constant-time (`crypto.timingSafeEqual`).
 *
 * Rotation:
 *   - issuing a new secret leaves the prior secret(s) `active` so a
 *     producer that hasn't seen the new key yet can still verify.
 *   - revoking a secret marks `status = 'revoked'`; verify rejects it
 *     immediately.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  tenantScope,
  webhookSecrets,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import {
  generateOpaqueToken,
  hmacSign,
  hmacVerify,
} from "../lib/security-crypto";
import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";

export class WebhookError extends Error {
  override readonly name = "WebhookError";
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface WebhookSecretSummary {
  readonly id: string;
  readonly endpoint: string;
  readonly label: string;
  readonly status: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface WebhookSecretCreated extends WebhookSecretSummary {
  readonly secret: string;
}

function toSummary(r: typeof webhookSecrets.$inferSelect): WebhookSecretSummary {
  return {
    id: r.id,
    endpoint: r.endpoint,
    label: r.label,
    status: r.status,
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function createWebhookSecret(
  ctx: TenantContext,
  input: { endpoint: string; label: string },
): Promise<WebhookSecretCreated> {
  if (!input.endpoint || !input.label) {
    throw new WebhookError("endpoint and label are required", "INVALID_INPUT", 400);
  }
  const id = `whk_${nanoid()}`;
  const secret = `whsec_${generateOpaqueToken(32)}`;
  const now = Date.now();
  await db.insert(webhookSecrets).values(
    withTenantValues(ctx, {
      id,
      endpoint: input.endpoint,
      label: input.label,
      secret,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "system",
    action: "webhook_secret.create",
    resourceType: "webhook_secret",
    resourceId: id,
    summary: `Created webhook secret ${input.label} for ${input.endpoint}`,
  });
  return {
    id,
    endpoint: input.endpoint,
    label: input.label,
    status: "active",
    lastUsedAt: null,
    createdAt: new Date(now).toISOString(),
    secret,
  };
}

export async function listWebhookSecrets(
  ctx: TenantContext,
  endpoint?: string,
): Promise<ReadonlyArray<WebhookSecretSummary>> {
  const conditions = endpoint
    ? and(tenantScope(ctx, webhookSecrets), eq(webhookSecrets.endpoint, endpoint))
    : tenantScope(ctx, webhookSecrets);
  const rows = await db.select().from(webhookSecrets).where(conditions);
  return rows.map(toSummary);
}

export async function revokeWebhookSecret(
  ctx: TenantContext,
  id: string,
): Promise<WebhookSecretSummary> {
  const rows = await db
    .select()
    .from(webhookSecrets)
    .where(and(tenantScope(ctx, webhookSecrets), eq(webhookSecrets.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new WebhookError(`No webhook secret with id ${id}`, "NOT_FOUND", 404);
  }
  const now = Date.now();
  await db
    .update(webhookSecrets)
    .set({ status: "revoked", revokedAt: now, updatedAt: now, version: row.version + 1 })
    .where(eq(webhookSecrets.id, id));
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "system",
    action: "webhook_secret.revoke",
    resourceType: "webhook_secret",
    resourceId: id,
    summary: `Revoked webhook secret ${row.label}`,
  });
  return { ...toSummary(row), status: "revoked" };
}

/**
 * Sign a payload for outbound webhooks — useful for our own producers
 * (e.g. a third-party listening on our published event endpoint).
 */
export async function signOutboundPayload(
  ctx: TenantContext,
  endpoint: string,
  payload: string,
): Promise<{ signature: string; secretId: string }> {
  const rows = await db
    .select()
    .from(webhookSecrets)
    .where(
      and(
        tenantScope(ctx, webhookSecrets),
        eq(webhookSecrets.endpoint, endpoint),
        eq(webhookSecrets.status, "active"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new WebhookError(`No active secret for endpoint ${endpoint}`, "NO_SECRET", 404);
  }
  const signature = hmacSign(row.secret, payload);
  return { signature, secretId: row.id };
}

/**
 * Verify an inbound webhook against every active secret for the
 * endpoint. Returns the matching secret id on success — the caller can
 * stamp `last_used_at` to surface "this secret is still in use".
 */
export async function verifyInboundPayload(
  ctx: TenantContext,
  endpoint: string,
  payload: string,
  signature: string,
): Promise<{ valid: boolean; secretId: string | null }> {
  const rows = await db
    .select()
    .from(webhookSecrets)
    .where(
      and(
        tenantScope(ctx, webhookSecrets),
        eq(webhookSecrets.endpoint, endpoint),
        eq(webhookSecrets.status, "active"),
      ),
    );
  for (const row of rows) {
    if (hmacVerify(row.secret, payload, signature)) {
      const now = Date.now();
      await db
        .update(webhookSecrets)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(webhookSecrets.id, row.id));
      return { valid: true, secretId: row.id };
    }
  }
  await logSecurityEvent(ctx, {
    eventType: "webhook.signature.invalid",
    severity: "high",
    actor: "external",
    target: endpoint,
  });
  return { valid: false, secretId: null };
}
