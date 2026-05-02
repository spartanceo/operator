/**
 * `master_password_state` — singleton-per-tenant record of the local
 * master password (Argon2id-style KDF) and biometric-unlock toggles.
 *
 * The KDF hash is the only secret stored on disk; the plaintext password
 * is never persisted. `biometricEnabled` records the user's preference;
 * actual Touch ID / Windows Hello bridges live in the desktop wrapper
 * and call `unlockWithBiometric()` on the `master-password.service` to
 * exchange a successful biometric prompt for a live session.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const masterPasswordState = sqliteTable(
  "master_password_state",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    kdfHash: text("kdf_hash").notNull(),
    kdfSalt: text("kdf_salt").notNull(),
    kdfAlgo: text("kdf_algo").notNull().default("scrypt-n16384-r8-p1"),
    biometricEnabled: integer("biometric_enabled").notNull().default(0),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: integer("locked_until"),
    setAt: integer("set_at").notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_master_password_state_tenant").on(t.tenantId),
    uniqTenant: uniqueIndex("idx_master_password_state_unique_tenant").on(t.tenantId),
  }),
);

export type MasterPasswordState = typeof masterPasswordState.$inferSelect;
export type NewMasterPasswordState = typeof masterPasswordState.$inferInsert;
