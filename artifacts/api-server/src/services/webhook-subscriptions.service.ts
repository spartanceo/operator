/**
 * Webhook subscription service for the Developer SDK (Task #14).
 *
 * NOT to be confused with `webhook.service.ts` (HMAC-secret store for
 * inbound provider webhooks). This service is the OUTBOUND side: it
 * keeps a tenant-scoped list of URLs that should receive a JSON POST
 * whenever the in-process event bus publishes an event matching the
 * subscription's filter.
 *
 * Delivery is best-effort. Failures bump `failureCount` and stamp the
 * last HTTP status; subscriptions that fail 10× in a row are
 * auto-disabled so a long-dead listener can't block the bus forever.
 */
import { and, desc, eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { nanoid } from "nanoid";

import { db, tenantScope, webhookSubscriptions, withTenantValues } from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import {
  registerEventDispatcher,
  type OpEvent,
} from "../lib/event-bus";
import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

export interface WebhookSubscriptionRow {
  id: string;
  url: string;
  label: string;
  eventTypes: string[];
  enabled: boolean;
  hasSecret: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: number | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreateSubscriptionInput {
  url: string;
  label?: string;
  eventTypes?: string[];
  secret?: string;
}

export interface UpdateSubscriptionInput {
  url?: string;
  label?: string;
  eventTypes?: string[];
  enabled?: boolean;
  secret?: string | null;
}

export class WebhookSubscriptionValidationError extends Error {
  override readonly name = "WebhookSubscriptionValidationError";
  readonly code = "WEBHOOK_SUB_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export class WebhookSubscriptionNotFoundError extends Error {
  override readonly name = "WebhookSubscriptionNotFoundError";
  readonly code = "WEBHOOK_SUB_NOT_FOUND";
  constructor(id: string) {
    super(`Unknown webhook subscription "${id}"`);
  }
}

const MAX_FAILURES_BEFORE_DISABLE = 10;

function parseEventTypes(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function toRow(r: typeof webhookSubscriptions.$inferSelect): WebhookSubscriptionRow {
  return {
    id: r.id,
    url: r.url,
    label: r.label,
    eventTypes: parseEventTypes(r.eventTypes),
    enabled: Boolean(r.enabled),
    hasSecret: Boolean(r.secret),
    lastDeliveryAt: r.lastDeliveryAt
      ? new Date(r.lastDeliveryAt).toISOString()
      : null,
    lastDeliveryStatus: r.lastDeliveryStatus,
    failureCount: r.failureCount,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    version: r.version,
  };
}

function assertLocalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookSubscriptionValidationError(`Invalid url: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebhookSubscriptionValidationError("url must use http(s)");
  }
  const host = parsed.hostname;
  if (
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "::1" &&
    !host.endsWith(".localhost")
  ) {
    throw new WebhookSubscriptionValidationError(
      "url must point to a loopback host (localhost / 127.0.0.1)",
    );
  }
}

export async function listSubscriptions(
  ctx: TenantContext,
): Promise<ReadonlyArray<WebhookSubscriptionRow>> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(tenantScope(ctx, webhookSubscriptions))
    .orderBy(desc(webhookSubscriptions.createdAt));
  return rows.map(toRow);
}

export async function getSubscription(
  ctx: TenantContext,
  id: string,
): Promise<WebhookSubscriptionRow | null> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(and(tenantScope(ctx, webhookSubscriptions), eq(webhookSubscriptions.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createSubscription(
  ctx: TenantContext,
  input: CreateSubscriptionInput,
): Promise<WebhookSubscriptionRow> {
  assertLocalUrl(input.url);
  const id = `whsub_${nanoid()}`;
  const eventTypes = (input.eventTypes ?? []).filter(
    (v) => typeof v === "string" && v.length > 0,
  );
  await db.insert(webhookSubscriptions).values(
    withTenantValues(ctx, {
      id,
      url: input.url,
      label: (input.label ?? "").trim(),
      eventTypes: JSON.stringify(eventTypes),
      secret: input.secret ?? null,
      enabled: true,
      failureCount: 0,
    }),
  );
  const row = await getSubscription(ctx, id);
  if (!row) throw new Error("Subscription vanished after creation");
  return row;
}

export async function updateSubscription(
  ctx: TenantContext,
  id: string,
  input: UpdateSubscriptionInput,
): Promise<WebhookSubscriptionRow> {
  const existing = await getSubscription(ctx, id);
  if (!existing) throw new WebhookSubscriptionNotFoundError(id);
  if (input.url !== undefined) assertLocalUrl(input.url);
  const patch: Partial<typeof webhookSubscriptions.$inferInsert> = {
    updatedAt: Date.now(),
    version: existing.version + 1,
  };
  if (input.url !== undefined) patch.url = input.url;
  if (input.label !== undefined) patch.label = input.label.trim();
  if (input.eventTypes !== undefined) {
    patch.eventTypes = JSON.stringify(
      input.eventTypes.filter((v) => typeof v === "string" && v.length > 0),
    );
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.secret !== undefined) patch.secret = input.secret;
  if (input.enabled === true) patch.failureCount = 0;
  await db
    .update(webhookSubscriptions)
    .set(patch)
    .where(
      and(
        tenantScope(ctx, webhookSubscriptions),
        eq(webhookSubscriptions.id, id),
        eq(webhookSubscriptions.version, existing.version),
      ),
    );
  const row = await getSubscription(ctx, id);
  if (!row) throw new WebhookSubscriptionNotFoundError(id);
  return row;
}

export async function deleteSubscription(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getSubscription(ctx, id);
  if (!existing) return { id, deleted: false };
  await db
    .delete(webhookSubscriptions)
    .where(and(tenantScope(ctx, webhookSubscriptions), eq(webhookSubscriptions.id, id)));
  return { id, deleted: true };
}

async function recordDeliveryResult(
  id: string,
  status: number | null,
  ok: boolean,
): Promise<void> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  const failureCount = ok ? 0 : row.failureCount + 1;
  const enabled = ok ? row.enabled : failureCount < MAX_FAILURES_BEFORE_DISABLE;
  await db
    .update(webhookSubscriptions)
    .set({
      lastDeliveryAt: Date.now(),
      lastDeliveryStatus: status,
      failureCount,
      enabled,
      updatedAt: Date.now(),
    })
    .where(eq(webhookSubscriptions.id, id));
}

async function dispatch(event: OpEvent): Promise<void> {
  // Tenant-scope the lookup directly so we don't need a TenantContext
  // shim — the event already carries tenantId/workspaceId.
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.tenantId, event.tenantId),
        eq(webhookSubscriptions.workspaceId, event.workspaceId),
        eq(webhookSubscriptions.enabled, true),
      ),
    );
  if (rows.length === 0) return;
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    tenantId: event.tenantId,
    workspaceId: event.workspaceId,
    data: event.data,
  });
  await Promise.all(
    rows.map(async (row) => {
      const filter = parseEventTypes(row.eventTypes);
      if (filter.length > 0 && !filter.includes(event.type)) return;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-omninity-event": event.type,
        "x-omninity-event-id": event.id,
      };
      if (row.secret) {
        const sig = createHmac("sha256", row.secret).update(body).digest("hex");
        headers["x-omninity-signature"] = `sha256=${sig}`;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5_000);
      try {
        // logPrivacyEvent paired with the fetch() call below to satisfy
        // tier-review Check #8 — every outbound network call must be audited.
        await logPrivacyEvent(
          { tenantId: event.tenantId, workspaceId: event.workspaceId, userId: null } as never,
          {
            eventType: "network.webhook",
            actor: event.tenantId,
            target: `webhook:${row.id}`,
            severity: "low",
            detail: event.type,
          },
        );
        const res = await fetch(row.url, {
          method: "POST",
          headers,
          body,
          signal: ctrl.signal,
        });
        await recordDeliveryResult(row.id, res.status, res.ok);
      } catch (err) {
        logger.warn({ err, subId: row.id }, "Webhook delivery failed");
        await recordDeliveryResult(row.id, null, false);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

let registered = false;
export function ensureWebhookDispatcherRegistered(): void {
  if (registered) return;
  registered = true;
  registerEventDispatcher(dispatch);
}

ensureWebhookDispatcherRegistered();
