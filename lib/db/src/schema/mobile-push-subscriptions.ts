/**
 * `mobile_push_subscriptions` — Web Push API subscriptions registered by
 * the Mobile Companion PWA so the desktop OP can deliver background
 * notifications (approval requests, task completion, etc.) even when the
 * PWA is closed.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { pairedDevices } from "./paired-devices";
import { tenants } from "./tenants";

export const mobilePushSubscriptions = sqliteTable(
  "mobile_push_subscriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    deviceId: text("device_id").notNull().references(() => pairedDevices.id),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_mobile_push_tenant").on(t.tenantId),
    deviceIdx: index("idx_mobile_push_device").on(t.deviceId),
  }),
);

export type MobilePushSubscription = typeof mobilePushSubscriptions.$inferSelect;
export type NewMobilePushSubscription = typeof mobilePushSubscriptions.$inferInsert;
