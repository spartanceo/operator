/**
 * `sso_login_events` — append-only audit of SSO login attempts.
 *
 * Powers the SSO health dashboard ("last successful login", "5 failed
 * attempts in the last hour"). Distinct from `audit_log_entries`
 * (compliance-grade hash chain) — this is the high-volume operational
 * signal. Append-only by convention, no `version` column (event table).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const ssoLoginEvents = sqliteTable(
  "sso_login_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    /** `saml` | `oidc` | `break_glass` */
    protocol: text("protocol").notNull(),
    /** `success` | `failure` */
    outcome: text("outcome").notNull(),
    /** Subject identifier from IdP (NameID for SAML, sub for OIDC). */
    subject: text("subject"),
    email: text("email"),
    /** When `outcome=failure`, the failure reason category. */
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_sso_login_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_sso_login_events_workspace").on(t.workspaceId),
    orgIdx: index("idx_sso_login_events_org").on(t.orgId),
    outcomeIdx: index("idx_sso_login_events_outcome").on(t.orgId, t.outcome),
    createdIdx: index("idx_sso_login_events_created").on(t.orgId, t.createdAt),
  }),
);

export type SsoLoginEvent = typeof ssoLoginEvents.$inferSelect;
export type NewSsoLoginEvent = typeof ssoLoginEvents.$inferInsert;
