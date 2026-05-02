/**
 * `auto_lock_state` — singleton-per-tenant inactivity policy + last-seen
 * heartbeat. The desktop shell pings the API every minute while the user
 * is active; the server compares `lastActivityAt` to `inactivityMinutes`
 * and signs the user out (and locks the master-password vault) when the
 * window is exceeded.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const autoLockState = sqliteTable(
  "auto_lock_state",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    inactivityMinutes: integer("inactivity_minutes").notNull().default(15),
    requireBiometric: integer("require_biometric").notNull().default(0),
    lastActivityAt: integer("last_activity_at").notNull().default(sql`(unixepoch() * 1000)`),
    locked: integer("locked").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_auto_lock_state_tenant").on(t.tenantId),
    uniqTenant: uniqueIndex("idx_auto_lock_state_unique_tenant").on(t.tenantId),
  }),
);

export type AutoLockState = typeof autoLockState.$inferSelect;
export type NewAutoLockState = typeof autoLockState.$inferInsert;
