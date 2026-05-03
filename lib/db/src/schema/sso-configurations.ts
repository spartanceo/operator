/**
 * `sso_configurations` — per-tenant Enterprise SSO configuration.
 *
 * One row per `enterprise_orgs` row (uniqueIndex on `org_id`). Holds the
 * organisation's IdP federation contract — SAML 2.0 or OIDC — plus the
 * enforcement, JIT-provisioning, and SLO toggles. The certificate /
 * client secret material is stored here so that the desktop install can
 * be air-gap-restored without round-tripping to a cloud control plane.
 *
 * Sensitive material:
 *   - `signingCertificatePem` — the IdP's public X.509 cert; PUBLIC, kept
 *     for SAML assertion verification.
 *   - `oidcClientSecret` — confidential. Only written when present and
 *     should be considered tenant-secret; the audit log records writes.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const ssoConfigurations = sqliteTable(
  "sso_configurations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    /** `saml` | `oidc` */
    protocol: text("protocol").notNull().default("saml"),
    /** Display label shown on the enterprise login page (e.g. "Acme SSO"). */
    displayName: text("display_name").notNull().default(""),
    /** Email-domain that triggers SSO routing on the login page. */
    emailDomain: text("email_domain").notNull().default(""),
    /** SAML — IdP entity ID (issuer), SSO URL, optional SLO URL, signing cert. */
    samlEntityId: text("saml_entity_id"),
    samlSsoUrl: text("saml_sso_url"),
    samlSloUrl: text("saml_slo_url"),
    samlSigningCertPem: text("saml_signing_cert_pem"),
    /** Whether incoming SAML responses are required to be signed. */
    samlWantAssertionsSigned: integer("saml_want_assertions_signed", { mode: "boolean" })
      .notNull()
      .default(true),
    /** OIDC — issuer URL, client id, secret, discovery cache. */
    oidcIssuer: text("oidc_issuer"),
    oidcClientId: text("oidc_client_id"),
    oidcClientSecret: text("oidc_client_secret"),
    oidcDiscoveryJson: text("oidc_discovery_json"),
    oidcDiscoveryFetchedAt: integer("oidc_discovery_fetched_at"),
    /** When true, password login is disabled for this org. */
    enforced: integer("enforced", { mode: "boolean" }).notNull().default(false),
    /** When true, first SSO login auto-creates the OP user (JIT). */
    jitProvisioning: integer("jit_provisioning", { mode: "boolean" }).notNull().default(true),
    /** When true, IdP-initiated SLO triggers OP session destruction. */
    singleLogoutEnabled: integer("single_logout_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    /** IdP session timeout (minutes) — refresh forced when exceeded. */
    sessionTimeoutMinutes: integer("session_timeout_minutes").notNull().default(480),
    /** Health: last successful login, last failed, last error message. */
    lastSuccessAt: integer("last_success_at"),
    lastFailureAt: integer("last_failure_at"),
    lastFailureMessage: text("last_failure_message"),
    /** Connectivity check timestamp + healthy flag. */
    lastHealthCheckAt: integer("last_health_check_at"),
    healthy: integer("healthy", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_sso_configurations_tenant").on(t.tenantId),
    workspaceIdx: index("idx_sso_configurations_workspace").on(t.workspaceId),
    orgIdx: index("idx_sso_configurations_org").on(t.orgId),
    orgUniqueIdx: uniqueIndex("uq_sso_configurations_org").on(t.orgId),
    domainIdx: uniqueIndex("uq_sso_configurations_domain").on(t.emailDomain),
  }),
);

export type SsoConfiguration = typeof ssoConfigurations.$inferSelect;
export type NewSsoConfiguration = typeof ssoConfigurations.$inferInsert;
