/**
 * `break_glass_accounts` — exactly one emergency local-admin per org.
 *
 * Bypasses SSO when the IdP is unreachable. The credential is a long
 * randomly generated passphrase shown ONCE at provisioning; only the
 * scrypt hash is persisted here. Every use is recorded in
 * `sso_login_events` AND appended to the compliance-grade audit log.
 *
 * `lastUsedAt` is the canonical "have we ever broken glass" signal —
 * the Enterprise Admin dashboard shows a banner whenever it is set.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const breakGlassAccounts = sqliteTable(
  "break_glass_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    email: text("email").notNull(),
    /** scrypt(N=16384,r=8,p=1) password hash, base64. */
    passwordHash: text("password_hash").notNull(),
    /** Random per-credential salt, base64. */
    passwordSalt: text("password_salt").notNull(),
    /** Last 4 chars of plaintext for visual identification. */
    passphraseSuffix: text("passphrase_suffix").notNull(),
    /** When provisioned/rotated. */
    issuedAt: integer("issued_at").notNull().default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer("last_used_at"),
    /** `active` | `revoked` */
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_break_glass_accounts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_break_glass_accounts_workspace").on(t.workspaceId),
    orgIdx: index("idx_break_glass_accounts_org").on(t.orgId),
    orgUniqueIdx: uniqueIndex("uq_break_glass_accounts_org").on(t.orgId),
  }),
);

export type BreakGlassAccount = typeof breakGlassAccounts.$inferSelect;
export type NewBreakGlassAccount = typeof breakGlassAccounts.$inferInsert;
