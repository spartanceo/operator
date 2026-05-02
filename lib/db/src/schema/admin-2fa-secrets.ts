/**
 * `admin_2fa_secrets` — TOTP shared secrets for super-admin accounts.
 *
 * One row per admin user; the secret is base32-encoded and used by the
 * `admin-2fa.service` to verify codes from authenticator apps (RFC 6238).
 * Enterprise-tier admins bypass this in favour of corporate SSO; super
 * admins (Replit-side operators) MUST have a row here.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { users } from "./users";

export const admin2faSecrets = sqliteTable(
  "admin_2fa_secrets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    userId: text("user_id").notNull().references(() => users.id),
    secretBase32: text("secret_base32").notNull(),
    confirmed: integer("confirmed").notNull().default(0),
    lastUsedCounter: integer("last_used_counter"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_admin_2fa_secrets_tenant").on(t.tenantId),
    userIdx: index("idx_admin_2fa_secrets_user").on(t.userId),
    uniqUser: uniqueIndex("idx_admin_2fa_secrets_unique_user").on(t.tenantId, t.userId),
  }),
);

export type Admin2faSecret = typeof admin2faSecrets.$inferSelect;
export type NewAdmin2faSecret = typeof admin2faSecrets.$inferInsert;
