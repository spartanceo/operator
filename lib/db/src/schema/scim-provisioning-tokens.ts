/**
 * `scim_provisioning_tokens` — bearer tokens that authenticate the IdP's
 * SCIM 2.0 provisioning client against `/api/scim/v2/*`.
 *
 * Only the SHA-256 hash is stored — the plaintext is shown ONCE at
 * creation. Tokens are scoped to an `enterprise_orgs.id` and revocable.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const scimProvisioningTokens = sqliteTable(
  "scim_provisioning_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    /** Human-readable label ("Okta production"). */
    label: text("label").notNull().default(""),
    /** SHA-256(plaintext-token) — comparison happens in constant time. */
    tokenHash: text("token_hash").notNull(),
    /** Identifying prefix (first 8 chars of plaintext) for UI display. */
    tokenPrefix: text("token_prefix").notNull(),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_scim_provisioning_tokens_tenant").on(t.tenantId),
    workspaceIdx: index("idx_scim_provisioning_tokens_workspace").on(t.workspaceId),
    orgIdx: index("idx_scim_provisioning_tokens_org").on(t.orgId),
    hashIdx: uniqueIndex("uq_scim_provisioning_tokens_hash").on(t.tokenHash),
  }),
);

export type ScimProvisioningToken = typeof scimProvisioningTokens.$inferSelect;
export type NewScimProvisioningToken = typeof scimProvisioningTokens.$inferInsert;
