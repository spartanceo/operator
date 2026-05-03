/**
 * SCIM 2.0 provisioning service (Task #55, RFC 7643/7644).
 *
 * Implements the subset of SCIM 2.0 the major IdPs (Okta, Azure AD,
 * OneLogin, JumpCloud) emit when configuring an outbound provisioning
 * connector:
 *
 *   POST   /Users           — create
 *   GET    /Users/{id}      — read
 *   GET    /Users           — list with `filter=userName eq "x"` etc.
 *   PUT    /Users/{id}      — replace
 *   PATCH  /Users/{id}      — { Operations: [...] }
 *   DELETE /Users/{id}      — deactivate (sets active=false; row stays
 *                              for audit trail).
 *
 *   POST   /Groups          — create
 *   GET    /Groups          — list
 *   GET    /Groups/{id}     — read
 *   PATCH  /Groups/{id}     — add/remove members
 *   DELETE /Groups/{id}     — drop
 *
 * Bearer auth is enforced by the route layer via `verifyScimToken`.
 *
 * This service treats `enterprise_seats` as the SCIM `Users` resource —
 * we never have a separate identity store. Group membership is stored
 * in `scim_groups.membersJson`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  enterpriseSeats,
  scimGroups,
  scimProvisioningTokens,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";
import { getOrCreateOrg } from "./enterprise-admin.service";
import { resolveRoleForGroups, type SsoRole } from "./sso";

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export type { SsoRole };

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string | null;
  userName: string;
  active: boolean;
  displayName: string;
  emails: Array<{ value: string; primary?: boolean }>;
  meta: { resourceType: "User"; created: string; lastModified: string };
}

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  displayName: string;
  members: Array<{ value: string; display?: string }>;
  meta: { resourceType: "Group"; created: string; lastModified: string };
}

// --------------------------- Token management ----------------------------

export interface IssuedScimToken {
  id: string;
  label: string;
  prefix: string;
  /** Plaintext — only available at issue time. */
  token: string;
  createdAt: string;
}

export async function issueScimToken(
  ctx: TenantContext,
  reviewer: string,
  label: string,
): Promise<IssuedScimToken> {
  const org = await getOrCreateOrg(ctx);
  const plaintext = `scim_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(plaintext).digest("hex");
  const id = `tok_${nanoid()}`;
  const now = Date.now();
  const prefix = plaintext.slice(0, 12);
  await db.insert(scimProvisioningTokens).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      label,
      tokenHash,
      tokenPrefix: prefix,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "scim.token.issue",
    resourceType: "scim_provisioning_token",
    resourceId: id,
    summary: `Issued SCIM token "${label}" (prefix=${prefix})`,
  });
  return {
    id,
    label,
    prefix,
    token: plaintext,
    createdAt: new Date(now).toISOString(),
  };
}

export async function listScimTokens(ctx: TenantContext) {
  const rows = await db
    .select()
    .from(scimProvisioningTokens)
    .where(tenantScope(ctx, scimProvisioningTokens));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    prefix: r.tokenPrefix,
    revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

export async function revokeScimToken(
  ctx: TenantContext,
  reviewer: string,
  id: string,
): Promise<{ revoked: boolean }> {
  const now = Date.now();
  const result = await db
    .update(scimProvisioningTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(tenantScope(ctx, scimProvisioningTokens), eq(scimProvisioningTokens.id, id)));
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "scim.token.revoke",
    resourceType: "scim_provisioning_token",
    resourceId: id,
    summary: `Revoked SCIM token ${id}`,
  });
  return { revoked: (result as unknown as { changes?: number }).changes !== 0 };
}

/**
 * Resolve a bearer token plaintext to its tenant context + org id, or
 * return null if the token is unknown / revoked. Constant-time compare.
 */
export async function verifyScimToken(plaintext: string): Promise<{
  tenantId: string;
  workspaceId: string;
  orgId: string;
  tokenId: string;
} | null> {
  if (!plaintext.startsWith("scim_")) return null;
  const tokenHash = createHash("sha256").update(plaintext).digest("hex");
  // We must scan all rows because the tenant id isn't yet known. Fine
  // for the SCIM endpoint which is per-IdP-call, not per-user.
  const rows = await db.select().from(scimProvisioningTokens);
  for (const r of rows) {
    if (r.revokedAt !== null) continue;
    const a = Buffer.from(r.tokenHash, "hex");
    const b = Buffer.from(tokenHash, "hex");
    if (a.length !== b.length) continue;
    if (timingSafeEqual(a, b)) {
      // Touch lastUsedAt — fire and forget, no need to await.
      void db
        .update(scimProvisioningTokens)
        .set({ lastUsedAt: Date.now() })
        .where(eq(scimProvisioningTokens.id, r.id));
      return {
        tenantId: r.tenantId,
        workspaceId: r.workspaceId,
        orgId: r.orgId,
        tokenId: r.id,
      };
    }
  }
  return null;
}

// --------------------------- User CRUD -----------------------------------

function seatToScimUser(r: typeof enterpriseSeats.$inferSelect): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: r.id,
    externalId: r.id,
    userName: r.email,
    active: r.status === "active",
    displayName: r.displayName || r.email,
    emails: [{ value: r.email, primary: true }],
    meta: {
      resourceType: "User",
      created: new Date(r.createdAt).toISOString(),
      lastModified: new Date(r.updatedAt).toISOString(),
    },
  };
}

export interface ScimUserInput {
  userName: string;
  displayName?: string;
  active?: boolean;
  emails?: Array<{ value: string; primary?: boolean }>;
  externalId?: string;
  groups?: ReadonlyArray<string>;
}

export async function scimCreateUser(
  ctx: TenantContext,
  input: ScimUserInput,
): Promise<ScimUserResource> {
  const org = await getOrCreateOrg(ctx);
  const email = (input.userName ?? input.emails?.[0]?.value ?? "").trim().toLowerCase();
  if (!email) throw new ScimError(400, "missing userName or emails");
  const now = Date.now();
  const role = await resolveRoleForGroups(ctx, input.groups ?? [], "standard");
  // Idempotency: if a seat with this email already exists, return it.
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
    return seatToScimUser(existing[0]);
  }
  const id = `seat_${nanoid()}`;
  await db.insert(enterpriseSeats).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      email,
      displayName: input.displayName ?? "",
      role,
      status: input.active === false ? "disabled" : "active",
      invitedAt: now,
      lastActiveAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: "scim",
    action: "scim.user.create",
    resourceType: "enterprise_seat",
    resourceId: id,
    summary: `SCIM created user ${email} (role=${role})`,
  });
  const fresh = await db
    .select()
    .from(enterpriseSeats)
    .where(eq(enterpriseSeats.id, id))
    .limit(1);
  return seatToScimUser(fresh[0]!);
}

export async function scimGetUser(
  ctx: TenantContext,
  id: string,
): Promise<ScimUserResource | null> {
  const rows = await db
    .select()
    .from(enterpriseSeats)
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, id)))
    .limit(1);
  return rows[0] ? seatToScimUser(rows[0]) : null;
}

export async function scimListUsers(
  ctx: TenantContext,
  filter: string | undefined,
): Promise<{
  schemas: string[];
  totalResults: number;
  Resources: ScimUserResource[];
  itemsPerPage: number;
  startIndex: number;
}> {
  const org = await getOrCreateOrg(ctx);
  const rows = await db
    .select()
    .from(enterpriseSeats)
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.orgId, org.id)));
  let filtered = rows;
  if (filter) {
    const m = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
    if (m && m[1]) {
      const target = m[1].toLowerCase();
      filtered = rows.filter((r) => r.email === target);
    }
  }
  const resources = filtered.map(seatToScimUser);
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    Resources: resources,
    itemsPerPage: resources.length,
    startIndex: 1,
  };
}

export async function scimReplaceUser(
  ctx: TenantContext,
  id: string,
  input: ScimUserInput,
): Promise<ScimUserResource | null> {
  const seat = await scimGetUser(ctx, id);
  if (!seat) return null;
  const status = input.active === false ? "disabled" : "active";
  const role = await resolveRoleForGroups(ctx, input.groups ?? [], "standard");
  await db
    .update(enterpriseSeats)
    .set({
      displayName: input.displayName ?? seat.displayName,
      status,
      role,
      updatedAt: Date.now(),
    })
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, id)));
  await appendAuditEntry(ctx, {
    actor: "scim",
    action: "scim.user.replace",
    resourceType: "enterprise_seat",
    resourceId: id,
    summary: `SCIM replaced user ${id} (active=${status === "active"})`,
  });
  return scimGetUser(ctx, id);
}

interface ScimPatchOp {
  op?: string;
  path?: string;
  value?: unknown;
}

export async function scimPatchUser(
  ctx: TenantContext,
  id: string,
  body: { Operations?: ScimPatchOp[]; operations?: ScimPatchOp[] },
): Promise<ScimUserResource | null> {
  const seat = await scimGetUser(ctx, id);
  if (!seat) return null;
  const ops = body.Operations ?? body.operations ?? [];
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  for (const op of ops) {
    const path = (op.path ?? "").toLowerCase();
    const verb = (op.op ?? "").toLowerCase();
    if (path === "active") {
      const v = op.value;
      const active = typeof v === "boolean" ? v : v === "true" || (v as { value?: unknown })?.value === true;
      updates["status"] = active ? "active" : "disabled";
    } else if (path === "displayname") {
      updates["displayName"] = String(op.value ?? "");
    } else if (verb === "replace" && typeof op.value === "object" && op.value) {
      const patch = op.value as Record<string, unknown>;
      if (typeof patch["active"] === "boolean") {
        updates["status"] = patch["active"] ? "active" : "disabled";
      }
      if (typeof patch["displayName"] === "string") {
        updates["displayName"] = patch["displayName"];
      }
    }
  }
  await db
    .update(enterpriseSeats)
    .set(updates)
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, id)));
  await appendAuditEntry(ctx, {
    actor: "scim",
    action: "scim.user.patch",
    resourceType: "enterprise_seat",
    resourceId: id,
    summary: `SCIM patched user ${id}`,
  });
  return scimGetUser(ctx, id);
}

export async function scimDeactivateUser(
  ctx: TenantContext,
  id: string,
): Promise<{ deactivated: boolean }> {
  const result = await db
    .update(enterpriseSeats)
    .set({ status: "disabled", updatedAt: Date.now() })
    .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, id)));
  await appendAuditEntry(ctx, {
    actor: "scim",
    action: "scim.user.deactivate",
    resourceType: "enterprise_seat",
    resourceId: id,
    summary: `SCIM deactivated user ${id}`,
  });
  return { deactivated: (result as unknown as { changes?: number }).changes !== 0 };
}

// --------------------------- Group CRUD ----------------------------------

function groupToResource(r: typeof scimGroups.$inferSelect): ScimGroupResource {
  let members: Array<{ value: string; display?: string }> = [];
  try {
    const parsed = JSON.parse(r.membersJson) as unknown;
    if (Array.isArray(parsed)) {
      members = parsed
        .map((m): { value: string; display?: string } | null => {
          if (typeof m === "string") return { value: m };
          if (m && typeof m === "object" && "value" in m) {
            return {
              value: String((m as { value: unknown }).value),
              display:
                "display" in m && typeof (m as { display?: unknown }).display === "string"
                  ? ((m as { display: string }).display)
                  : undefined,
            };
          }
          return null;
        })
        .filter((m): m is { value: string; display?: string } => m !== null);
    }
  } catch {
    members = [];
  }
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: r.id,
    displayName: r.displayName,
    members,
    meta: {
      resourceType: "Group",
      created: new Date(r.createdAt).toISOString(),
      lastModified: new Date(r.updatedAt).toISOString(),
    },
  };
}

export interface ScimGroupInput {
  displayName: string;
  externalId?: string;
  members?: Array<{ value: string; display?: string }>;
}

export async function scimCreateGroup(
  ctx: TenantContext,
  input: ScimGroupInput,
): Promise<ScimGroupResource> {
  const org = await getOrCreateOrg(ctx);
  const id = `grp_${nanoid()}`;
  const now = Date.now();
  await db.insert(scimGroups).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      externalId: input.externalId ?? id,
      displayName: input.displayName,
      membersJson: JSON.stringify(input.members ?? []),
      createdAt: now,
      updatedAt: now,
    }),
  );
  await applyGroupRoleSync(ctx, input.displayName, input.members ?? []);
  await appendAuditEntry(ctx, {
    actor: "scim",
    action: "scim.group.create",
    resourceType: "scim_group",
    resourceId: id,
    summary: `SCIM created group "${input.displayName}" (${(input.members ?? []).length} members)`,
  });
  const fresh = await db.select().from(scimGroups).where(eq(scimGroups.id, id)).limit(1);
  return groupToResource(fresh[0]!);
}

export async function scimListGroups(ctx: TenantContext): Promise<{
  schemas: string[];
  totalResults: number;
  Resources: ScimGroupResource[];
  itemsPerPage: number;
  startIndex: number;
}> {
  const rows = await db.select().from(scimGroups).where(tenantScope(ctx, scimGroups));
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: rows.length,
    Resources: rows.map(groupToResource),
    itemsPerPage: rows.length,
    startIndex: 1,
  };
}

export async function scimGetGroup(
  ctx: TenantContext,
  id: string,
): Promise<ScimGroupResource | null> {
  const rows = await db
    .select()
    .from(scimGroups)
    .where(and(tenantScope(ctx, scimGroups), eq(scimGroups.id, id)))
    .limit(1);
  return rows[0] ? groupToResource(rows[0]) : null;
}

export async function scimPatchGroup(
  ctx: TenantContext,
  id: string,
  body: { Operations?: ScimPatchOp[]; operations?: ScimPatchOp[] },
): Promise<ScimGroupResource | null> {
  const group = await scimGetGroup(ctx, id);
  if (!group) return null;
  const ops = body.Operations ?? body.operations ?? [];
  let members = [...group.members];
  for (const op of ops) {
    const verb = (op.op ?? "").toLowerCase();
    if (verb === "add" && Array.isArray(op.value)) {
      const additions = (op.value as Array<{ value: string; display?: string }>).filter(
        (m) => typeof m?.value === "string",
      );
      const seen = new Set(members.map((m) => m.value));
      for (const add of additions) if (!seen.has(add.value)) members.push(add);
    } else if (verb === "remove") {
      const path = op.path ?? "";
      const m = /value\s+eq\s+"([^"]+)"/i.exec(path);
      if (m && m[1]) {
        const target = m[1];
        members = members.filter((mb) => mb.value !== target);
      } else if (path.startsWith("members")) {
        members = [];
      }
    } else if (verb === "replace" && Array.isArray(op.value)) {
      members = (op.value as Array<{ value: string; display?: string }>).filter(
        (m) => typeof m?.value === "string",
      );
    }
  }
  await db
    .update(scimGroups)
    .set({ membersJson: JSON.stringify(members), updatedAt: Date.now() })
    .where(and(tenantScope(ctx, scimGroups), eq(scimGroups.id, id)));
  await applyGroupRoleSync(ctx, group.displayName, members);
  await appendAuditEntry(ctx, {
    actor: "scim",
    action: "scim.group.patch",
    resourceType: "scim_group",
    resourceId: id,
    summary: `SCIM patched group ${group.displayName} → ${members.length} members`,
  });
  return scimGetGroup(ctx, id);
}

export async function scimDeleteGroup(
  ctx: TenantContext,
  id: string,
): Promise<{ removed: boolean }> {
  const result = await db
    .delete(scimGroups)
    .where(and(tenantScope(ctx, scimGroups), eq(scimGroups.id, id)));
  await appendAuditEntry(ctx, {
    actor: "scim",
    action: "scim.group.delete",
    resourceType: "scim_group",
    resourceId: id,
    summary: `SCIM deleted group ${id}`,
  });
  return { removed: (result as unknown as { changes?: number }).changes !== 0 };
}

/**
 * After a group is created or its members change, sync the role
 * assignment for every seat in the group based on the active mappings.
 */
async function applyGroupRoleSync(
  ctx: TenantContext,
  displayName: string,
  members: ReadonlyArray<{ value: string }>,
): Promise<void> {
  if (members.length === 0) return;
  const role = await resolveRoleForGroups(ctx, [displayName], "standard");
  for (const m of members) {
    await db
      .update(enterpriseSeats)
      .set({ role, updatedAt: Date.now() })
      .where(and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.id, m.value)));
  }
}

// --------------------------- Errors --------------------------------------

export class ScimError extends Error {
  override readonly name = "ScimError";
  readonly status: number;
  readonly scimType?: string;
  constructor(status: number, message: string, scimType?: string) {
    super(message);
    this.status = status;
    if (scimType) this.scimType = scimType;
  }
  toBody(): { schemas: string[]; status: string; detail: string; scimType?: string } {
    const body: { schemas: string[]; status: string; detail: string; scimType?: string } = {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(this.status),
      detail: this.message,
    };
    if (this.scimType) body.scimType = this.scimType;
    return body;
  }
}
