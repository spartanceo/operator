/**
 * `scim_groups` — IdP groups synced via SCIM /Groups.
 *
 * The membership list is stored as a JSON array of SCIM user IDs (which
 * map to `enterprise_seats.id` after JIT provisioning). The role
 * mapping rules in `sso_group_role_mappings` consult `displayName` to
 * decide each member's OP role.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const scimGroups = sqliteTable(
  "scim_groups",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    /** External SCIM id (from IdP). */
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    /** JSON array of SCIM member user IDs. */
    membersJson: text("members_json").notNull().default("[]"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_scim_groups_tenant").on(t.tenantId),
    workspaceIdx: index("idx_scim_groups_workspace").on(t.workspaceId),
    orgIdx: index("idx_scim_groups_org").on(t.orgId),
    externalIdx: uniqueIndex("uq_scim_groups_external").on(t.orgId, t.externalId),
  }),
);

export type ScimGroup = typeof scimGroups.$inferSelect;
export type NewScimGroup = typeof scimGroups.$inferInsert;
