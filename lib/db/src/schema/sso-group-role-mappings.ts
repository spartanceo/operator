/**
 * `sso_group_role_mappings` — IdP group → OP role mapping rules.
 *
 * Evaluated on every SSO login and SCIM group sync. The first rule whose
 * `groupName` matches an IdP group claim wins; if none match, the
 * `defaultRole` on `sso_configurations` is applied (enterprise admin can
 * reorder rules via `priority`, ascending = higher precedence).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const ssoGroupRoleMappings = sqliteTable(
  "sso_group_role_mappings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    /** IdP group name (case-insensitive comparison). */
    groupName: text("group_name").notNull(),
    /** OP role assigned to users in this group. admin | standard | readonly */
    role: text("role").notNull().default("standard"),
    /** Lower = higher precedence; ties broken by createdAt ascending. */
    priority: integer("priority").notNull().default(100),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_sso_group_role_mappings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_sso_group_role_mappings_workspace").on(t.workspaceId),
    orgIdx: index("idx_sso_group_role_mappings_org").on(t.orgId),
    pairIdx: uniqueIndex("uq_sso_group_role_mappings").on(t.orgId, t.groupName),
  }),
);

export type SsoGroupRoleMapping = typeof ssoGroupRoleMappings.$inferSelect;
export type NewSsoGroupRoleMapping = typeof ssoGroupRoleMappings.$inferInsert;
