/**
 * `secret_vault_entries` — encrypted credential store.
 *
 * A row holds one OAuth token, API key, or local password, encrypted with
 * AES-256-GCM using a key derived from the master password. The plaintext
 * never lands on disk; only the ciphertext + IV + auth tag are stored.
 *
 * On macOS / Windows / Linux the `keychain.service` swaps this file-backed
 * storage for the OS keychain (Mac Keychain, Windows Credential Manager,
 * Secret Service via libsecret) — the schema row remains as the lookup
 * record so the UI can list "what credentials exist" without unlocking.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const secretVaultEntries = sqliteTable(
  "secret_vault_entries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    namespace: text("namespace").notNull(),
    keyName: text("key_name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    backend: text("backend").notNull().default("file"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_secret_vault_entries_tenant").on(t.tenantId),
    namespaceIdx: index("idx_secret_vault_entries_namespace").on(t.tenantId, t.namespace),
    uniqKey: uniqueIndex("idx_secret_vault_entries_unique_key").on(
      t.tenantId,
      t.namespace,
      t.keyName,
    ),
  }),
);

export type SecretVaultEntry = typeof secretVaultEntries.$inferSelect;
export type NewSecretVaultEntry = typeof secretVaultEntries.$inferInsert;
