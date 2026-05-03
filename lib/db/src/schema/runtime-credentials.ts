/**
 * `runtime_credentials` — encrypted API keys for cloud runtime adapters
 * (OpenAI, Anthropic). Default of zero rows = local-only operation.
 *
 * The plaintext key is never stored. We AES-256-GCM encrypt with a key
 * derived from `RUNTIME_KEY_SECRET` (and a per-row IV) before insert, and
 * the encrypted blob + iv + tag are persisted as opaque base64. On the
 * desktop build this layer is replaced by the OS keychain — the
 * `runtime_credentials` table is the local-server fallback for headless /
 * server installs.
 *
 * (runtime_id, tenant_id) is unique — one credential per runtime per tenant.
 *
 * NOTE on column shape: per Check #5 we keep the column object flat with no
 * nested option literals. Timestamps are integer milliseconds.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const runtimeCredentials = sqliteTable(
  "runtime_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    runtimeId: text("runtime_id").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    label: text("label"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_runtime_credentials_tenant").on(t.tenantId),
    runtimeIdx: index("idx_runtime_credentials_runtime").on(t.tenantId, t.runtimeId),
    uniqueRuntimeTenantIdx: uniqueIndex("uniq_runtime_credentials_tenant_runtime").on(
      t.tenantId,
      t.runtimeId,
    ),
  }),
);

export type RuntimeCredential = typeof runtimeCredentials.$inferSelect;
export type NewRuntimeCredential = typeof runtimeCredentials.$inferInsert;
