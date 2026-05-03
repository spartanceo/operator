/**
 * Enterprise SSO orchestration service (Task #55).
 *
 * Public surface — service layer used by:
 *   - `routes/sso/*`    — SP-initiated and IdP-initiated login + SLO.
 *   - `routes/scim/*`   — SCIM 2.0 provisioning.
 *   - `routes/admin/sso.ts` — config + group rules + tokens.
 *   - `routes/admin/break-glass.ts` — emergency local admin.
 *
 * Pulls together: config storage, IdP metadata parsing, SAML/OIDC
 * primitives, JIT user provisioning, group→role mapping, login event
 * logging, audit-log emission, and SSO health computation.
 */
import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  enterpriseSeats,
  normaliseLimit,
  type PaginatedData,
  ssoConfigurations,
  ssoGroupRoleMappings,
  ssoLoginEvents,
  ssoSessions,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "../audit.service";
import { getOrCreateOrg } from "../enterprise-admin.service";

import { buildLogoutRequest, certFingerprint, parseIdpMetadata } from "./saml";

const HEALTH_FAILURE_THRESHOLD = 5;
const HEALTH_WINDOW_MS = 60 * 60 * 1000;

export type SsoProtocol = "saml" | "oidc";
export type SsoRole = "admin" | "standard" | "readonly";

export interface SsoConfigRow {
  id: string;
  protocol: SsoProtocol;
  displayName: string;
  emailDomain: string;
  enforced: boolean;
  jitProvisioning: boolean;
  singleLogoutEnabled: boolean;
  sessionTimeoutMinutes: number;
  saml: {
    entityId: string | null;
    ssoUrl: string | null;
    sloUrl: string | null;
    signingCertFingerprint: string | null;
    wantAssertionsSigned: boolean;
  };
  oidc: {
    issuer: string | null;
    clientId: string | null;
    hasClientSecret: boolean;
    discoveryFetchedAt: string | null;
  };
  health: {
    healthy: boolean;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureMessage: string | null;
    lastHealthCheckAt: string | null;
    failuresLastHour: number;
  };
  createdAt: string;
  updatedAt: string;
}

function toConfigRow(
  r: typeof ssoConfigurations.$inferSelect,
  failuresLastHour: number,
): SsoConfigRow {
  return {
    id: r.id,
    protocol: (r.protocol === "oidc" ? "oidc" : "saml") as SsoProtocol,
    displayName: r.displayName,
    emailDomain: r.emailDomain,
    enforced: Boolean(r.enforced),
    jitProvisioning: Boolean(r.jitProvisioning),
    singleLogoutEnabled: Boolean(r.singleLogoutEnabled),
    sessionTimeoutMinutes: r.sessionTimeoutMinutes,
    saml: {
      entityId: r.samlEntityId,
      ssoUrl: r.samlSsoUrl,
      sloUrl: r.samlSloUrl,
      signingCertFingerprint: r.samlSigningCertPem ? certFingerprint(r.samlSigningCertPem) : null,
      wantAssertionsSigned: Boolean(r.samlWantAssertionsSigned),
    },
    oidc: {
      issuer: r.oidcIssuer,
      clientId: r.oidcClientId,
      hasClientSecret: Boolean(r.oidcClientSecret),
      discoveryFetchedAt: r.oidcDiscoveryFetchedAt
        ? new Date(r.oidcDiscoveryFetchedAt).toISOString()
        : null,
    },
    health: {
      healthy: Boolean(r.healthy),
      lastSuccessAt: r.lastSuccessAt ? new Date(r.lastSuccessAt).toISOString() : null,
      lastFailureAt: r.lastFailureAt ? new Date(r.lastFailureAt).toISOString() : null,
      lastFailureMessage: r.lastFailureMessage,
      lastHealthCheckAt: r.lastHealthCheckAt
        ? new Date(r.lastHealthCheckAt).toISOString()
        : null,
      failuresLastHour,
    },
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

async function readConfigRowOrNull(
  ctx: TenantContext,
): Promise<typeof ssoConfigurations.$inferSelect | null> {
  const rows = await db
    .select()
    .from(ssoConfigurations)
    .where(tenantScope(ctx, ssoConfigurations))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSsoConfig(ctx: TenantContext): Promise<SsoConfigRow | null> {
  const row = await readConfigRowOrNull(ctx);
  if (!row) return null;
  const failuresLastHour = await countRecentFailures(ctx, row.orgId);
  return toConfigRow(row, failuresLastHour);
}

/**
 * Read the raw SAML signing certificate PEM. Used by the SAML ACS
 * handler to verify response signatures — never returned by the public
 * config-read endpoint.
 */
export async function getSamlSigningCertPem(ctx: TenantContext): Promise<string | null> {
  const row = await readConfigRowOrNull(ctx);
  return row?.samlSigningCertPem ?? null;
}

/**
 * Read the raw OIDC client secret. Used by the OIDC callback to
 * exchange the auth code — never returned by the public config-read.
 */
export async function getOidcClientSecret(ctx: TenantContext): Promise<string | null> {
  const row = await readConfigRowOrNull(ctx);
  return row?.oidcClientSecret ?? null;
}

async function countRecentFailures(ctx: TenantContext, orgId: string): Promise<number> {
  const cutoff = Date.now() - HEALTH_WINDOW_MS;
  const [{ n: c = 0 } = { n: 0 }] = await db
    .select({ n: count() })
    .from(ssoLoginEvents)
    .where(
      and(
        tenantScope(ctx, ssoLoginEvents),
        eq(ssoLoginEvents.orgId, orgId),
        eq(ssoLoginEvents.outcome, "failure"),
        gte(ssoLoginEvents.createdAt, cutoff),
      ),
    );
  return Number(c ?? 0);
}

export interface UpsertConfigInput {
  protocol?: SsoProtocol;
  displayName?: string;
  emailDomain?: string;
  enforced?: boolean;
  jitProvisioning?: boolean;
  singleLogoutEnabled?: boolean;
  sessionTimeoutMinutes?: number;
  samlEntityId?: string | null;
  samlSsoUrl?: string | null;
  samlSloUrl?: string | null;
  samlSigningCertPem?: string | null;
  samlWantAssertionsSigned?: boolean;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  oidcClientSecret?: string | null;
}

/**
 * Upsert the calling tenant's SSO configuration. Returns the materialised
 * row. Auto-creates the parent enterprise org row if missing.
 */
export async function upsertSsoConfig(
  ctx: TenantContext,
  reviewer: string,
  patch: UpsertConfigInput,
): Promise<SsoConfigRow> {
  const org = await getOrCreateOrg(ctx);
  const now = Date.now();
  const existing = await readConfigRowOrNull(ctx);
  const id = existing?.id ?? `sso_${nanoid()}`;
  const merged = {
    id,
    orgId: org.id,
    protocol: patch.protocol ?? existing?.protocol ?? "saml",
    displayName: patch.displayName ?? existing?.displayName ?? "",
    emailDomain: (patch.emailDomain ?? existing?.emailDomain ?? "").toLowerCase(),
    enforced: patch.enforced ?? Boolean(existing?.enforced) ?? false,
    jitProvisioning: patch.jitProvisioning ?? Boolean(existing?.jitProvisioning) ?? true,
    singleLogoutEnabled:
      patch.singleLogoutEnabled ?? Boolean(existing?.singleLogoutEnabled) ?? true,
    sessionTimeoutMinutes:
      Math.max(5, Math.min(60 * 24 * 7, patch.sessionTimeoutMinutes ?? existing?.sessionTimeoutMinutes ?? 480)),
    samlEntityId: patch.samlEntityId !== undefined ? patch.samlEntityId : (existing?.samlEntityId ?? null),
    samlSsoUrl: patch.samlSsoUrl !== undefined ? patch.samlSsoUrl : (existing?.samlSsoUrl ?? null),
    samlSloUrl: patch.samlSloUrl !== undefined ? patch.samlSloUrl : (existing?.samlSloUrl ?? null),
    samlSigningCertPem:
      patch.samlSigningCertPem !== undefined
        ? patch.samlSigningCertPem
        : (existing?.samlSigningCertPem ?? null),
    samlWantAssertionsSigned:
      patch.samlWantAssertionsSigned ?? Boolean(existing?.samlWantAssertionsSigned ?? true),
    oidcIssuer: patch.oidcIssuer !== undefined ? patch.oidcIssuer : (existing?.oidcIssuer ?? null),
    oidcClientId:
      patch.oidcClientId !== undefined ? patch.oidcClientId : (existing?.oidcClientId ?? null),
    oidcClientSecret:
      patch.oidcClientSecret !== undefined
        ? patch.oidcClientSecret
        : (existing?.oidcClientSecret ?? null),
    updatedAt: now,
  };
  if (existing) {
    await db.update(ssoConfigurations).set(merged).where(eq(ssoConfigurations.id, id));
  } else {
    await db.insert(ssoConfigurations).values(
      withTenantValues(ctx, {
        ...merged,
        oidcDiscoveryJson: null,
        oidcDiscoveryFetchedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureMessage: null,
        lastHealthCheckAt: null,
        healthy: true,
        createdAt: now,
      }),
    );
  }
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "sso.config.update",
    resourceType: "sso_configuration",
    resourceId: id,
    summary: `Updated SSO config (${Object.keys(patch).join(", ")})`,
  });
  return (await getSsoConfig(ctx))!;
}

/**
 * Apply a parsed IdP metadata blob to the calling tenant's SAML config.
 */
export async function applyIdpMetadataXml(
  ctx: TenantContext,
  reviewer: string,
  xml: string,
): Promise<SsoConfigRow> {
  const parsed = parseIdpMetadata(xml);
  if (!parsed.entityId || !parsed.ssoUrl) {
    throw new SsoConfigError(
      "INVALID_METADATA",
      "IdP metadata missing entityID or SingleSignOnService Location",
    );
  }
  return upsertSsoConfig(ctx, reviewer, {
    protocol: "saml",
    samlEntityId: parsed.entityId,
    samlSsoUrl: parsed.ssoUrl,
    samlSloUrl: parsed.sloUrl,
    samlSigningCertPem: parsed.signingCertPem,
  });
}

/**
 * Cache an OIDC discovery doc on the configuration row.
 */
export async function persistOidcDiscovery(
  ctx: TenantContext,
  discoveryJson: string,
): Promise<void> {
  const existing = await readConfigRowOrNull(ctx);
  if (!existing) return;
  await db
    .update(ssoConfigurations)
    .set({
      oidcDiscoveryJson: discoveryJson,
      oidcDiscoveryFetchedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(ssoConfigurations.id, existing.id));
}

// --------------------------- Group → role mapping ------------------------

export interface GroupRoleRule {
  id: string;
  groupName: string;
  role: SsoRole;
  priority: number;
  updatedAt: string;
}

function ruleToRow(r: typeof ssoGroupRoleMappings.$inferSelect): GroupRoleRule {
  return {
    id: r.id,
    groupName: r.groupName,
    role: (r.role === "admin" || r.role === "readonly" ? r.role : "standard") as SsoRole,
    priority: r.priority,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listGroupMappings(ctx: TenantContext): Promise<GroupRoleRule[]> {
  const org = await getOrCreateOrg(ctx);
  const rows = await db
    .select()
    .from(ssoGroupRoleMappings)
    .where(
      and(tenantScope(ctx, ssoGroupRoleMappings), eq(ssoGroupRoleMappings.orgId, org.id)),
    )
    .orderBy(ssoGroupRoleMappings.priority);
  return rows.map(ruleToRow);
}

export async function upsertGroupMapping(
  ctx: TenantContext,
  reviewer: string,
  input: { groupName: string; role: SsoRole; priority?: number },
): Promise<GroupRoleRule> {
  const org = await getOrCreateOrg(ctx);
  const now = Date.now();
  const existing = await db
    .select()
    .from(ssoGroupRoleMappings)
    .where(
      and(
        tenantScope(ctx, ssoGroupRoleMappings),
        eq(ssoGroupRoleMappings.orgId, org.id),
        eq(ssoGroupRoleMappings.groupName, input.groupName),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(ssoGroupRoleMappings)
      .set({
        role: input.role,
        priority: input.priority ?? existing[0].priority,
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(eq(ssoGroupRoleMappings.id, existing[0].id));
  } else {
    await db.insert(ssoGroupRoleMappings).values(
      withTenantValues(ctx, {
        id: `grm_${nanoid()}`,
        orgId: org.id,
        groupName: input.groupName,
        role: input.role,
        priority: input.priority ?? 100,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "sso.group_mapping.upsert",
    resourceType: "sso_group_role_mapping",
    resourceId: input.groupName,
    summary: `Mapped group "${input.groupName}" → ${input.role}`,
  });
  const fresh = await db
    .select()
    .from(ssoGroupRoleMappings)
    .where(
      and(
        tenantScope(ctx, ssoGroupRoleMappings),
        eq(ssoGroupRoleMappings.orgId, org.id),
        eq(ssoGroupRoleMappings.groupName, input.groupName),
      ),
    )
    .limit(1);
  return ruleToRow(fresh[0]!);
}

export async function deleteGroupMapping(
  ctx: TenantContext,
  reviewer: string,
  id: string,
): Promise<{ removed: boolean }> {
  const result = await db
    .delete(ssoGroupRoleMappings)
    .where(and(tenantScope(ctx, ssoGroupRoleMappings), eq(ssoGroupRoleMappings.id, id)));
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "sso.group_mapping.delete",
    resourceType: "sso_group_role_mapping",
    resourceId: id,
    summary: `Removed group mapping ${id}`,
  });
  return { removed: (result as unknown as { changes?: number }).changes !== 0 };
}

/**
 * Resolve the role for a set of IdP groups. The first matching rule
 * (lowest priority) wins; if no rule matches, returns `defaultRole`.
 */
export async function resolveRoleForGroups(
  ctx: TenantContext,
  groups: ReadonlyArray<string>,
  defaultRole: SsoRole = "standard",
): Promise<SsoRole> {
  const rules = await listGroupMappings(ctx);
  const lower = new Set(groups.map((g) => g.toLowerCase()));
  for (const r of rules) {
    if (lower.has(r.groupName.toLowerCase())) return r.role;
  }
  return defaultRole;
}

// --------------------------- JIT provisioning ----------------------------

export interface JitProvisionInput {
  protocol: SsoProtocol;
  email: string;
  displayName: string | null;
  groups: ReadonlyArray<string>;
  subject: string;
}

export interface JitProvisionResult {
  seatId: string;
  email: string;
  role: SsoRole;
  created: boolean;
}

/**
 * Find or create an `enterprise_seats` row for an SSO subject. Triggered
 * on every SSO success when `jitProvisioning` is enabled. Idempotent.
 */
export async function jitProvisionSeat(
  ctx: TenantContext,
  reviewer: string,
  input: JitProvisionInput,
): Promise<JitProvisionResult> {
  const org = await getOrCreateOrg(ctx);
  const now = Date.now();
  const role = await resolveRoleForGroups(ctx, input.groups, "standard");
  const email = input.email.trim().toLowerCase();
  const existing = await db
    .select()
    .from(enterpriseSeats)
    .where(
      and(
        tenantScope(ctx, enterpriseSeats),
        eq(enterpriseSeats.orgId, org.id),
        eq(enterpriseSeats.email, email),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(enterpriseSeats)
      .set({
        role,
        status: "active",
        lastActiveAt: now,
        displayName: input.displayName ?? existing[0].displayName,
        updatedAt: now,
        version: existing[0].version + 1,
      })
      .where(eq(enterpriseSeats.id, existing[0].id));
    await appendAuditEntry(ctx, {
      actor: reviewer,
      action: "sso.jit.update",
      resourceType: "enterprise_seat",
      resourceId: existing[0].id,
      summary: `JIT updated ${email} → role ${role}`,
    });
    return { seatId: existing[0].id, email, role, created: false };
  }
  const id = `seat_${nanoid()}`;
  await db.insert(enterpriseSeats).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      email,
      displayName: input.displayName ?? "",
      role,
      status: "active",
      invitedAt: now,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "sso.jit.create",
    resourceType: "enterprise_seat",
    resourceId: id,
    summary: `JIT provisioned ${email} as ${role} via ${input.protocol}`,
  });
  return { seatId: id, email, role, created: true };
}

// --------------------------- Login event log -----------------------------

export interface LoginEventInput {
  protocol: "saml" | "oidc" | "break_glass";
  outcome: "success" | "failure";
  subject?: string | null;
  email?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
}

export async function recordLoginEvent(
  ctx: TenantContext,
  input: LoginEventInput,
): Promise<void> {
  const org = await getOrCreateOrg(ctx);
  const now = Date.now();
  await db.insert(ssoLoginEvents).values(
    withTenantValues(ctx, {
      id: `sle_${nanoid()}`,
      orgId: org.id,
      protocol: input.protocol,
      outcome: input.outcome,
      subject: input.subject ?? null,
      email: input.email ?? null,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
      sourceIp: input.sourceIp ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  // Update health summary on the config row.
  const cfg = await readConfigRowOrNull(ctx);
  if (cfg) {
    const updates: Record<string, unknown> = { updatedAt: now };
    if (input.outcome === "success") {
      updates["lastSuccessAt"] = now;
      updates["healthy"] = true;
      updates["lastFailureMessage"] = null;
    } else {
      updates["lastFailureAt"] = now;
      updates["lastFailureMessage"] = input.failureMessage ?? input.failureCode ?? "failure";
      const recent = await countRecentFailures(ctx, cfg.orgId);
      updates["healthy"] = recent < HEALTH_FAILURE_THRESHOLD;
    }
    await db.update(ssoConfigurations).set(updates).where(eq(ssoConfigurations.id, cfg.id));
  }
}

export interface LoginEventRow {
  id: string;
  protocol: string;
  outcome: string;
  subject: string | null;
  email: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  sourceIp: string | null;
  createdAt: string;
}

export async function listLoginEvents(
  ctx: TenantContext,
  input: { cursor?: string | null; limit?: number },
): Promise<PaginatedData<LoginEventRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const baseScope = tenantScope(ctx, ssoLoginEvents);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(ssoLoginEvents.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(ssoLoginEvents)
    .where(where)
    .orderBy(desc(ssoLoginEvents.createdAt))
    .limit(limit + 1);
  const items: LoginEventRow[] = rows.map((r) => ({
    id: r.id,
    protocol: r.protocol,
    outcome: r.outcome,
    subject: r.subject,
    email: r.email,
    failureCode: r.failureCode,
    failureMessage: r.failureMessage,
    sourceIp: r.sourceIp,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
  return buildPage(items, limit, (r) => String(new Date(r.createdAt).getTime()));
}

// --------------------------- SSO sessions / SLO --------------------------

export async function createSsoSession(
  ctx: TenantContext,
  input: {
    userId: string;
    sessionId: string;
    idpSubject: string;
    idpSessionIndex: string | null;
    expiresAtMs: number;
  },
): Promise<void> {
  const org = await getOrCreateOrg(ctx);
  const now = Date.now();
  await db.insert(ssoSessions).values(
    withTenantValues(ctx, {
      id: `sss_${nanoid()}`,
      orgId: org.id,
      userId: input.userId,
      sessionId: input.sessionId,
      idpSubject: input.idpSubject,
      idpSessionIndex: input.idpSessionIndex,
      expiresAt: input.expiresAtMs,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/**
 * Resolve an OP session id from an IdP-supplied session index or NameID.
 * Returns the row(s) the SLO handler should terminate.
 */
export async function findSessionsForSlo(
  ctx: TenantContext,
  input: { idpSessionIndex?: string | null; idpSubject?: string | null },
): Promise<ReadonlyArray<typeof ssoSessions.$inferSelect>> {
  const conditions = [tenantScope(ctx, ssoSessions), eq(ssoSessions.status, "active")];
  if (input.idpSessionIndex) {
    conditions.push(eq(ssoSessions.idpSessionIndex, input.idpSessionIndex));
  } else if (input.idpSubject) {
    conditions.push(eq(ssoSessions.idpSubject, input.idpSubject));
  } else {
    return [];
  }
  return await db
    .select()
    .from(ssoSessions)
    .where(and(...conditions));
}

export async function terminateSsoSession(
  ctx: TenantContext,
  rowId: string,
): Promise<void> {
  const now = Date.now();
  await db
    .update(ssoSessions)
    .set({ status: "terminated", updatedAt: now })
    .where(and(tenantScope(ctx, ssoSessions), eq(ssoSessions.id, rowId)));
}

export function buildSamlSloRedirect(input: {
  spEntityId: string;
  idpSloUrl: string;
  nameId: string;
  sessionIndex: string | null;
}): string {
  return buildLogoutRequest(input).redirectUrl;
}

// --------------------------- Errors --------------------------------------

export class SsoConfigError extends Error {
  override readonly name = "SsoConfigError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export {
  // Re-export low-level helpers so the routes layer doesn't import
  // `services/sso/saml` etc. directly — keeps the surface area small.
  parseIdpMetadata,
  certFingerprint,
};
