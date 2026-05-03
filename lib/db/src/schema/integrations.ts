/**
 * `integrations` — installed third-party integrations (Notion, Slack,
 * GitHub, etc.).
 *
 * Each row represents one connection between a tenant and an external
 * provider. Credentials are stored ENCRYPTED at rest (AES-256-GCM); the
 * `credentials_encrypted` column carries the opaque ciphertext envelope.
 *
 * The unique `(tenant_id, provider)` index means a tenant has at most one
 * connection per provider — connecting again rotates the credentials in
 * place rather than creating a duplicate row.
 *
 * The status column is named `connection_status` (not `status`) to keep
 * the GDPR-soft-delete convention reserved for tenant lifecycle: the
 * `tenantScope` helper auto-excludes rows where `table.status = 'erased'`,
 * which would silently hide every disconnected integration.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    authType: text("auth_type").notNull(),
    connectionStatus: text("connection_status").notNull().default("disconnected"),
    credentialsEncrypted: text("credentials_encrypted"),
    accountLabel: text("account_label"),
    lastTestedAt: integer("last_tested_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_integrations_tenant").on(t.tenantId),
    workspaceIdx: index("idx_integrations_workspace").on(t.workspaceId),
    providerIdx: index("idx_integrations_provider").on(t.tenantId, t.provider),
    uniqueProvider: uniqueIndex("uniq_integrations_tenant_provider").on(
      t.tenantId,
      t.provider,
    ),
  }),
);

export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
