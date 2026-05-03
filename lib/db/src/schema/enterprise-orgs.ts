/**
 * `enterprise_orgs` — one row per business customer.
 *
 * Holds branding, billing, plan/seat capacity, optional SSO config and
 * the air-gap toggle. Exactly one row per tenant (uniqueIndex on
 * `tenant_id`); the org is automatically materialised on first access
 * to the Enterprise Admin portal.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const enterpriseOrgs = sqliteTable(
  "enterprise_orgs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    primaryColor: text("primary_color").notNull().default("#F2A341"),
    plan: text("plan").notNull().default("business"),
    seatLimit: integer("seat_limit").notNull().default(5),
    airGapped: integer("air_gapped", { mode: "boolean" }).notNull().default(false),
    ssoProvider: text("sso_provider"),
    ssoDomain: text("sso_domain"),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_enterprise_orgs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_enterprise_orgs_workspace").on(t.workspaceId),
    tenantUniqueIdx: uniqueIndex("uq_enterprise_orgs_tenant").on(t.tenantId),
  }),
);

export type EnterpriseOrg = typeof enterpriseOrgs.$inferSelect;
export type NewEnterpriseOrg = typeof enterpriseOrgs.$inferInsert;

/**
 * `enterprise_seats` — per-user seat assignment with role.
 */
export const enterpriseSeats = sqliteTable(
  "enterprise_seats",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    /** admin | standard | readonly */
    role: text("role").notNull().default("standard"),
    /** invited | active | disabled */
    status: text("status").notNull().default("invited"),
    invitedAt: integer("invited_at").notNull().default(sql`(unixepoch() * 1000)`),
    lastActiveAt: integer("last_active_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_enterprise_seats_tenant").on(t.tenantId),
    workspaceIdx: index("idx_enterprise_seats_workspace").on(t.workspaceId),
    orgIdx: index("idx_enterprise_seats_org").on(t.orgId),
    emailIdx: uniqueIndex("uq_enterprise_seats_org_email").on(t.orgId, t.email),
  }),
);

export type EnterpriseSeat = typeof enterpriseSeats.$inferSelect;
export type NewEnterpriseSeat = typeof enterpriseSeats.$inferInsert;

/**
 * `enterprise_skill_whitelist` — allow-listed skills per org.
 */
export const enterpriseSkillWhitelist = sqliteTable(
  "enterprise_skill_whitelist",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    skillSlug: text("skill_slug").notNull(),
    skillName: text("skill_name").notNull().default(""),
    allowed: integer("allowed", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_enterprise_skill_whitelist_tenant").on(t.tenantId),
    workspaceIdx: index("idx_enterprise_skill_whitelist_workspace").on(t.workspaceId),
    orgIdx: index("idx_enterprise_skill_whitelist_org").on(t.orgId),
    pairIdx: uniqueIndex("uq_enterprise_skill_whitelist").on(t.orgId, t.skillSlug),
  }),
);

export type EnterpriseSkillWhitelistRow = typeof enterpriseSkillWhitelist.$inferSelect;
export type NewEnterpriseSkillWhitelistRow = typeof enterpriseSkillWhitelist.$inferInsert;
