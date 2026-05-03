/**
 * `webhook_subscriptions` — per-tenant outbound webhook delivery targets.
 *
 * The in-process event bus posts a structured JSON payload to `url`
 * whenever an emitted event's type matches one of the entries in the
 * subscription's `eventTypes` array. An empty list means "all events".
 *
 * `secret` (optional) is used to HMAC-sign the body in the
 * `X-Omninity-Signature` header so the receiver can verify authenticity.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    url: text("url").notNull(),
    label: text("label").notNull().default(""),
    /** JSON-encoded array of event-type strings; [] = all. */
    eventTypes: text("event_types").notNull().default("[]"),
    secret: text("secret"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastDeliveryAt: integer("last_delivery_at"),
    lastDeliveryStatus: integer("last_delivery_status"),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_webhook_subs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_webhook_subs_workspace").on(t.workspaceId),
    enabledIdx: index("idx_webhook_subs_enabled").on(t.tenantId, t.enabled),
  }),
);

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
