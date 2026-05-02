/**
 * `webhook_secrets` — per-tenant HMAC keys used to sign and verify
 * inbound/outbound webhook payloads (Stripe, Resend, custom integrations).
 *
 * Rotating a key issues a new row and marks the old one `revoked`. The
 * verifier accepts any non-revoked key for the same `endpoint` so rotation
 * is a zero-downtime operation.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const webhookSecrets = sqliteTable(
  "webhook_secrets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    endpoint: text("endpoint").notNull(),
    label: text("label").notNull(),
    secret: text("secret").notNull(),
    status: text("status").notNull().default("active"),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_webhook_secrets_tenant").on(t.tenantId),
    endpointIdx: index("idx_webhook_secrets_endpoint").on(t.tenantId, t.endpoint),
    statusIdx: index("idx_webhook_secrets_status").on(t.tenantId, t.status),
  }),
);

export type WebhookSecret = typeof webhookSecrets.$inferSelect;
export type NewWebhookSecret = typeof webhookSecrets.$inferInsert;
