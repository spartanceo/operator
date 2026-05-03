/**
 * `sso_sessions` — links an OP session to its IdP session.
 *
 * Stores the IdP-side `sessionIndex` (SAML) or `sid` (OIDC) so that an
 * IdP-initiated SLO LogoutRequest can be resolved back to the OP session
 * row to destroy.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { users } from "./users";
import { workspaces } from "./workspaces";

export const ssoSessions = sqliteTable(
  "sso_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    userId: text("user_id").notNull().references(() => users.id),
    /** Express session id (cookie value). */
    sessionId: text("session_id").notNull(),
    /** SAML SessionIndex / OIDC `sid`. Nullable when IdP doesn't supply it. */
    idpSessionIndex: text("idp_session_index"),
    /** SAML NameID / OIDC `sub`. */
    idpSubject: text("idp_subject").notNull(),
    /** Hard expiry from IdP — sessions auto-rejected past this point. */
    expiresAt: integer("expires_at").notNull(),
    /** `active` | `terminated` */
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_sso_sessions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_sso_sessions_workspace").on(t.workspaceId),
    orgIdx: index("idx_sso_sessions_org").on(t.orgId),
    userIdx: index("idx_sso_sessions_user").on(t.userId),
    sessionIdx: uniqueIndex("uq_sso_sessions_session").on(t.sessionId),
    idpIdx: index("idx_sso_sessions_idp").on(t.orgId, t.idpSessionIndex),
  }),
);

export type SsoSession = typeof ssoSessions.$inferSelect;
export type NewSsoSession = typeof ssoSessions.$inferInsert;
