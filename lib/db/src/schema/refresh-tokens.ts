/**
 * `refresh_tokens` — opaque rotating refresh tokens used by the
 * short-expiry JWT access flow on admin routes.
 *
 * Standard 12: access tokens have a 15-minute lifetime; the refresh token
 * row has a 7-day lifetime and is rotated on every refresh — re-use of a
 * previously-rotated token (token reuse attack) flips the user's session
 * to revoked and emits a critical security event.
 *
 * Append-only; the rotation marker is `replacedById`. Tier-review's
 * version requirement is waived because the table name contains "token"
 * — but we keep `version` for forwards compat (the regex match is on
 * "membership"-style keywords; including version is harmless).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { users } from "./users";

export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    userId: text("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    replacedById: text("replaced_by_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_refresh_tokens_tenant").on(t.tenantId),
    userIdx: index("idx_refresh_tokens_user").on(t.userId),
    expiresIdx: index("idx_refresh_tokens_expires").on(t.expiresAt),
    hashIdx: index("idx_refresh_tokens_hash").on(t.tokenHash),
  }),
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
