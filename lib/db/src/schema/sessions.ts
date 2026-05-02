/**
 * `sessions` — opaque session tokens for the local web client.
 *
 * One row per active login. `expiresAt` is the absolute deadline; the
 * session middleware rejects tokens past their expiry without touching the
 * row. Membership-style table — exempt from the version requirement (the
 * tier-review check matches "session" as a membership keyword via name
 * heuristics; we still include `version` to be explicit and forwards-safe).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { users } from "./users";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    userId: text("user_id").notNull().references(() => users.id),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_sessions_tenant").on(t.tenantId),
    userIdx: index("idx_sessions_user").on(t.userId),
    expiresIdx: index("idx_sessions_expires").on(t.expiresAt),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
