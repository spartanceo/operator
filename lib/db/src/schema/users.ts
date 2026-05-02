/**
 * `users` — local-account identity (bcrypt password hash).
 *
 * A user belongs to exactly one tenant. Authentication is local-first: the
 * password hash never leaves the device. The `lastLoginAt` field is updated
 * on every successful login so the UI can surface a "last seen" indicator.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().default("owner"),
    lastLoginAt: integer("last_login_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_users_tenant").on(t.tenantId),
    emailIdx: uniqueIndex("idx_users_tenant_email").on(t.tenantId, t.email),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
