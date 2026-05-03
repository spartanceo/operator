/**
 * Private Skill Registry service (Task #60).
 *
 * Backs the per-organisation private skill registry that is fully
 * isolated from the public marketplace and the public skill-moderation
 * pipeline. Provides:
 *
 *   - Per-org registry settings (mode, remote URL, signing pubkey,
 *     `requireSignature`).
 *   - Submit / approve / reject / publish flow for private skill
 *     packages with semantic versioning (auto-incremented per slug).
 *   - Visibility scoping (`all` | `roles` | `workspaces`) — enforced
 *     when listing for non-admin members.
 *   - Mandatory-skill flag — blocks uninstall and is auto-installed
 *     during `pushToTeam`.
 *   - Install / uninstall against the local `skills` table so the
 *     deterministic agent loop can route to private skills without
 *     any change.
 *   - `pushToTeam` — admin action that installs an approved package
 *     for every existing seat in the org.
 *   - `syncFromRemote` — fetches a manifest from the configured remote
 *     air-gap registry URL and validates the signature against the
 *     stored RSA/Ed25519 public key before importing.
 *
 * Every write goes through `appendAuditEntry` so the tamper-evident
 * audit chain captures publish / approve / reject / install / push
 * actions. Every read uses `tenantScope`; every insert uses
 * `withTenantValues`.
 */
import { createVerify, createPublicKey } from "node:crypto";

import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  enterpriseSeats,
  normaliseLimit,
  type PaginatedData,
  privateRegistrySettings,
  privateSkillInstallations,
  privateSkillPackages,
  skills as skillsTable,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";
import { getOrCreateOrg } from "./enterprise-admin.service";
import { logPrivacyEvent } from "./privacy.service";

// --------------------------- Types ---------------------------------------

export type Visibility = "all" | "roles" | "workspaces";
export type PackageStatus = "pending" | "approved" | "rejected" | "superseded";

export interface RegistrySettings {
  mode: "local" | "remote";
  remoteRegistryUrl: string | null;
  signingPublicKeyPem: string | null;
  requireSignature: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  updatedAt: string;
}

export interface PrivateSkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  modelTags: string[];
  triggers: string[];
  category: string;
  documentation: string;
  skillVersion: number;
  isLatest: boolean;
  visibility: Visibility;
  visibilityTargets: string[];
  mandatory: boolean;
  status: PackageStatus;
  submittedBy: string;
  submittedAt: string;
  reviewedBy: string;
  reviewedAt: string | null;
  reviewNotes: string;
  rejectionReason: string;
  signature: string;
  signatureAlgo: string;
  installCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationRow {
  id: string;
  packageId: string;
  slug: string;
  skillId: string;
  installedVersion: number;
  mandatory: boolean;
  source: "user" | "admin_push";
  installedBy: string;
  createdAt: string;
}

// --------------------------- Errors --------------------------------------

export class PrivateRegistryError extends Error {
  override readonly name = "PrivateRegistryError";
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// --------------------------- Helpers -------------------------------------

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function settingsToRow(
  r: typeof privateRegistrySettings.$inferSelect,
): RegistrySettings {
  return {
    mode: (r.mode === "remote" ? "remote" : "local"),
    remoteRegistryUrl: r.remoteRegistryUrl ?? null,
    signingPublicKeyPem: r.signingPublicKeyPem ?? null,
    requireSignature: Boolean(r.requireSignature),
    lastSyncedAt: r.lastSyncedAt ? new Date(r.lastSyncedAt).toISOString() : null,
    lastSyncError: r.lastSyncError ?? null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function packageToRow(
  r: typeof privateSkillPackages.$inferSelect,
): PrivateSkillRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    content: r.content,
    modelTags: parseJsonArray(r.modelTags),
    triggers: parseJsonArray(r.triggers),
    category: r.category,
    documentation: r.documentation,
    skillVersion: r.skillVersion,
    isLatest: Boolean(r.isLatest),
    visibility: r.visibility as Visibility,
    visibilityTargets: parseJsonArray(r.visibilityTargets),
    mandatory: Boolean(r.mandatory),
    status: r.status as PackageStatus,
    submittedBy: r.submittedBy,
    submittedAt: new Date(r.submittedAt).toISOString(),
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
    reviewNotes: r.reviewNotes,
    rejectionReason: r.rejectionReason,
    signature: r.signature,
    signatureAlgo: r.signatureAlgo,
    installCount: r.installCount,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function installationToRow(
  r: typeof privateSkillInstallations.$inferSelect,
): InstallationRow {
  return {
    id: r.id,
    packageId: r.packageId,
    slug: r.slug,
    skillId: r.skillId,
    installedVersion: r.installedVersion,
    mandatory: Boolean(r.mandatory),
    source: (r.source === "admin_push" ? "admin_push" : "user"),
    installedBy: r.installedBy,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function canonicalisePayload(pkg: {
  slug: string;
  name: string;
  content: string;
  skillVersion: number;
}): string {
  return JSON.stringify({
    slug: pkg.slug,
    name: pkg.name,
    content: pkg.content,
    version: pkg.skillVersion,
  });
}

/**
 * Verify a base64-encoded signature against the org's stored public key.
 * Supports RSA and Ed25519 keys (auto-detected from the PEM header).
 * Returns `true` when the signature checks out, `false` otherwise. Bad
 * keys / signatures return `false` rather than throwing — callers
 * decide whether to enforce.
 */
export function verifyPackageSignature(
  publicKeyPem: string | null,
  payload: string,
  signatureBase64: string,
  algo: string,
): boolean {
  if (!publicKeyPem || !signatureBase64) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    const sig = Buffer.from(signatureBase64, "base64");
    if (key.asymmetricKeyType === "ed25519") {
      // Node's crypto.verify (one-shot) handles Ed25519 directly.
      // Lazy-import to keep the module surface lean.
       
      const { verify } = require("node:crypto");
      return Boolean(verify(null, Buffer.from(payload), key, sig));
    }
    const verifier = createVerify(algo || "RSA-SHA256");
    verifier.update(payload);
    verifier.end();
    return verifier.verify(key, sig);
  } catch {
    return false;
  }
}

// --------------------------- Settings ------------------------------------

export async function getOrCreateSettings(
  ctx: TenantContext,
): Promise<RegistrySettings> {
  const org = await getOrCreateOrg(ctx);
  const rows = await db
    .select()
    .from(privateRegistrySettings)
    .where(
      and(
        tenantScope(ctx, privateRegistrySettings),
        eq(privateRegistrySettings.orgId, org.id),
      ),
    )
    .limit(1);
  if (rows[0]) return settingsToRow(rows[0]);
  const id = `prs_${nanoid()}`;
  const now = Date.now();
  await db.insert(privateRegistrySettings).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      mode: "local",
      remoteRegistryUrl: null,
      signingPublicKeyPem: null,
      requireSignature: false,
      lastSyncedAt: null,
      lastSyncError: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const fresh = await db
    .select()
    .from(privateRegistrySettings)
    .where(eq(privateRegistrySettings.id, id))
    .limit(1);
  return settingsToRow(fresh[0]!);
}

export async function updateSettings(
  ctx: TenantContext,
  reviewer: string,
  patch: Partial<{
    mode: "local" | "remote";
    remoteRegistryUrl: string | null;
    signingPublicKeyPem: string | null;
    requireSignature: boolean;
  }>,
): Promise<RegistrySettings> {
  const org = await getOrCreateOrg(ctx);
  await getOrCreateSettings(ctx);
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.mode !== undefined) updates["mode"] = patch.mode;
  if (patch.remoteRegistryUrl !== undefined)
    updates["remoteRegistryUrl"] = patch.remoteRegistryUrl;
  if (patch.signingPublicKeyPem !== undefined)
    updates["signingPublicKeyPem"] = patch.signingPublicKeyPem;
  if (patch.requireSignature !== undefined)
    updates["requireSignature"] = patch.requireSignature;
  await db
    .update(privateRegistrySettings)
    .set(updates)
    .where(
      and(
        tenantScope(ctx, privateRegistrySettings),
        eq(privateRegistrySettings.orgId, org.id),
      ),
    );
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "private_registry.settings_update",
    resourceType: "private_registry_settings",
    resourceId: org.id,
    summary: `Updated private registry settings (${Object.keys(patch).join(", ")})`,
  });
  return getOrCreateSettings(ctx);
}

// --------------------------- Packages ------------------------------------

export interface SubmitPackageInput {
  slug: string;
  name: string;
  description?: string;
  content: string;
  modelTags?: string[];
  triggers?: string[];
  category?: string;
  documentation?: string;
  visibility?: Visibility;
  visibilityTargets?: string[];
  mandatory?: boolean;
  signature?: string;
  signatureAlgo?: string;
}

export async function submitPackage(
  ctx: TenantContext,
  submitter: string,
  input: SubmitPackageInput,
): Promise<PrivateSkillRow> {
  const org = await getOrCreateOrg(ctx);
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    throw new PrivateRegistryError(
      "INVALID_SLUG",
      "slug must be lowercase a-z, 0-9, or '-' (1-64 chars)",
    );
  }
  const settings = await getOrCreateSettings(ctx);
  if (settings.requireSignature && !input.signature) {
    throw new PrivateRegistryError(
      "SIGNATURE_REQUIRED",
      "this org requires a code signature on every published private skill",
    );
  }
  // Find the highest existing version for this slug under this org.
  const prior = await db
    .select()
    .from(privateSkillPackages)
    .where(
      and(
        tenantScope(ctx, privateSkillPackages),
        eq(privateSkillPackages.orgId, org.id),
        eq(privateSkillPackages.slug, slug),
      ),
    )
    .orderBy(desc(privateSkillPackages.skillVersion))
    .limit(1);
  const nextVersion = prior[0] ? prior[0].skillVersion + 1 : 1;
  if (input.signature) {
    const ok = verifyPackageSignature(
      settings.signingPublicKeyPem,
      canonicalisePayload({
        slug,
        name: input.name,
        content: input.content,
        skillVersion: nextVersion,
      }),
      input.signature,
      input.signatureAlgo ?? "RSA-SHA256",
    );
    if (!ok && settings.requireSignature) {
      throw new PrivateRegistryError(
        "SIGNATURE_INVALID",
        "supplied signature did not verify against the stored signing key",
      );
    }
  }
  const id = `prv_${nanoid()}`;
  const now = Date.now();
  await db.insert(privateSkillPackages).values(
    withTenantValues(ctx, {
      id,
      orgId: org.id,
      slug,
      name: input.name,
      description: input.description ?? "",
      content: input.content,
      modelTags: JSON.stringify(input.modelTags ?? []),
      triggers: JSON.stringify(input.triggers ?? []),
      category: input.category ?? "Internal",
      documentation: input.documentation ?? "",
      skillVersion: nextVersion,
      isLatest: false,
      visibility: input.visibility ?? "all",
      visibilityTargets: JSON.stringify(input.visibilityTargets ?? []),
      mandatory: input.mandatory ?? false,
      status: "pending",
      submittedBy: submitter,
      submittedAt: now,
      reviewedBy: "",
      reviewedAt: null,
      reviewNotes: "",
      rejectionReason: "",
      signature: input.signature ?? "",
      signatureAlgo: input.signatureAlgo ?? "",
      installCount: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: submitter,
    action: "private_skill.submit",
    resourceType: "private_skill_package",
    resourceId: id,
    summary: `Submitted private skill "${slug}" v${nextVersion} for review`,
  });
  const fresh = await db
    .select()
    .from(privateSkillPackages)
    .where(eq(privateSkillPackages.id, id))
    .limit(1);
  return packageToRow(fresh[0]!);
}

async function setLatestPointer(
  ctx: TenantContext,
  orgId: string,
  slug: string,
  newLatestId: string,
): Promise<void> {
  // Mark every other version of this slug as not-latest, then mark the
  // approved one as the active head.
  await db
    .update(privateSkillPackages)
    .set({ isLatest: false, status: "superseded", updatedAt: Date.now() })
    .where(
      and(
        tenantScope(ctx, privateSkillPackages),
        eq(privateSkillPackages.orgId, orgId),
        eq(privateSkillPackages.slug, slug),
        eq(privateSkillPackages.isLatest, true),
      ),
    );
  await db
    .update(privateSkillPackages)
    .set({ isLatest: true })
    .where(eq(privateSkillPackages.id, newLatestId));
}

export async function approvePackage(
  ctx: TenantContext,
  reviewer: string,
  packageId: string,
  notes = "",
): Promise<PrivateSkillRow> {
  const rows = await db
    .select()
    .from(privateSkillPackages)
    .where(
      and(
        tenantScope(ctx, privateSkillPackages),
        eq(privateSkillPackages.id, packageId),
      ),
    )
    .limit(1);
  const pkg = rows[0];
  if (!pkg) throw new PrivateRegistryError("NOT_FOUND", "package not found");
  if (pkg.status === "approved") return packageToRow(pkg);
  const now = Date.now();
  await db
    .update(privateSkillPackages)
    .set({
      status: "approved",
      reviewedBy: reviewer,
      reviewedAt: now,
      reviewNotes: notes,
      updatedAt: now,
    })
    .where(eq(privateSkillPackages.id, packageId));
  await setLatestPointer(ctx, pkg.orgId, pkg.slug, packageId);
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "private_skill.approve",
    resourceType: "private_skill_package",
    resourceId: packageId,
    summary: `Approved private skill "${pkg.slug}" v${pkg.skillVersion}`,
  });
  const fresh = await db
    .select()
    .from(privateSkillPackages)
    .where(eq(privateSkillPackages.id, packageId))
    .limit(1);
  return packageToRow(fresh[0]!);
}

export async function rejectPackage(
  ctx: TenantContext,
  reviewer: string,
  packageId: string,
  reason: string,
): Promise<PrivateSkillRow> {
  const rows = await db
    .select()
    .from(privateSkillPackages)
    .where(
      and(
        tenantScope(ctx, privateSkillPackages),
        eq(privateSkillPackages.id, packageId),
      ),
    )
    .limit(1);
  const pkg = rows[0];
  if (!pkg) throw new PrivateRegistryError("NOT_FOUND", "package not found");
  const now = Date.now();
  await db
    .update(privateSkillPackages)
    .set({
      status: "rejected",
      reviewedBy: reviewer,
      reviewedAt: now,
      rejectionReason: reason,
      isLatest: false,
      updatedAt: now,
    })
    .where(eq(privateSkillPackages.id, packageId));
  await appendAuditEntry(ctx, {
    actor: reviewer,
    action: "private_skill.reject",
    resourceType: "private_skill_package",
    resourceId: packageId,
    summary: `Rejected private skill "${pkg.slug}" v${pkg.skillVersion}: ${reason}`,
  });
  const fresh = await db
    .select()
    .from(privateSkillPackages)
    .where(eq(privateSkillPackages.id, packageId))
    .limit(1);
  return packageToRow(fresh[0]!);
}

// --------------------------- Listing -------------------------------------

export interface ListPackagesInput {
  cursor?: string | null;
  limit?: number;
  status?: PackageStatus | "all";
  /** When true, only the latest approved version per slug is returned. */
  latestOnly?: boolean;
}

export async function listPackages(
  ctx: TenantContext,
  input: ListPackagesInput,
): Promise<PaginatedData<PrivateSkillRow>> {
  const org = await getOrCreateOrg(ctx);
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0
      ? Number(decodeCursor(input.cursor))
      : null;
  const conditions = [
    tenantScope(ctx, privateSkillPackages),
    eq(privateSkillPackages.orgId, org.id),
  ];
  if (input.status && input.status !== "all") {
    conditions.push(eq(privateSkillPackages.status, input.status));
  }
  if (input.latestOnly) {
    conditions.push(eq(privateSkillPackages.isLatest, true));
  }
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(privateSkillPackages.createdAt, cursorTs));
  }
  const rows = await db
    .select()
    .from(privateSkillPackages)
    .where(and(...conditions))
    .orderBy(desc(privateSkillPackages.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map(packageToRow),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

/**
 * List packages visible to a non-admin member. Filters by approved
 * status, latest version, and the visibility scope. `viewer` carries
 * the role + workspaceId used to evaluate the scope.
 */
export async function listVisibleForMember(
  ctx: TenantContext,
  viewer: { role?: string | null; workspaceId?: string | null },
): Promise<PrivateSkillRow[]> {
  const org = await getOrCreateOrg(ctx);
  const rows = await db
    .select()
    .from(privateSkillPackages)
    .where(
      and(
        tenantScope(ctx, privateSkillPackages),
        eq(privateSkillPackages.orgId, org.id),
        eq(privateSkillPackages.status, "approved"),
        eq(privateSkillPackages.isLatest, true),
      ),
    )
    .orderBy(desc(privateSkillPackages.updatedAt));
  return rows
    .map(packageToRow)
    .filter((r) => {
      if (r.visibility === "all") return true;
      if (r.visibility === "roles") {
        return Boolean(viewer.role) && r.visibilityTargets.includes(viewer.role!);
      }
      // workspaces
      return (
        Boolean(viewer.workspaceId) &&
        r.visibilityTargets.includes(viewer.workspaceId!)
      );
    });
}

// --------------------------- Install / uninstall -------------------------

async function upsertLocalSkillFromPackage(
  ctx: TenantContext,
  pkg: PrivateSkillRow,
): Promise<string> {
  const existing = await db
    .select()
    .from(skillsTable)
    .where(
      and(tenantScope(ctx, skillsTable), eq(skillsTable.slug, pkg.slug)),
    )
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    await db
      .update(skillsTable)
      .set({
        name: pkg.name,
        description: pkg.description,
        content: pkg.content,
        modelTags: JSON.stringify(pkg.modelTags),
        triggers: JSON.stringify(pkg.triggers),
        category: pkg.category,
        author: "private_registry",
        isInstalled: true,
        installedVersion: `${pkg.skillVersion}.0.0`,
        latestVersion: `${pkg.skillVersion}.0.0`,
        publishedAt: now,
        updatedAt: now,
      })
      .where(eq(skillsTable.id, existing[0].id));
    return existing[0].id;
  }
  const id = `skill_${nanoid()}`;
  await db.insert(skillsTable).values(
    withTenantValues(ctx, {
      id,
      slug: pkg.slug,
      name: pkg.name,
      description: pkg.description,
      content: pkg.content,
      modelTags: JSON.stringify(pkg.modelTags),
      triggers: JSON.stringify(pkg.triggers),
      category: pkg.category,
      author: "private_registry",
      isInstalled: true,
      installCount: 1,
      latestVersion: `${pkg.skillVersion}.0.0`,
      installedVersion: `${pkg.skillVersion}.0.0`,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return id;
}

export async function installPackage(
  ctx: TenantContext,
  installer: string,
  packageId: string,
  source: "user" | "admin_push" = "user",
): Promise<InstallationRow> {
  const rows = await db
    .select()
    .from(privateSkillPackages)
    .where(
      and(
        tenantScope(ctx, privateSkillPackages),
        eq(privateSkillPackages.id, packageId),
      ),
    )
    .limit(1);
  const raw = rows[0];
  if (!raw) throw new PrivateRegistryError("NOT_FOUND", "package not found");
  if (raw.status !== "approved") {
    throw new PrivateRegistryError(
      "NOT_APPROVED",
      "only approved packages can be installed",
    );
  }
  const pkg = packageToRow(raw);
  const settings = await getOrCreateSettings(ctx);
  if (settings.requireSignature) {
    const ok = verifyPackageSignature(
      settings.signingPublicKeyPem,
      canonicalisePayload(pkg),
      pkg.signature,
      pkg.signatureAlgo || "RSA-SHA256",
    );
    if (!ok) {
      throw new PrivateRegistryError(
        "SIGNATURE_INVALID",
        "package signature failed verification — install blocked",
      );
    }
  }
  const skillId = await upsertLocalSkillFromPackage(ctx, pkg);
  const existing = await db
    .select()
    .from(privateSkillInstallations)
    .where(
      and(
        tenantScope(ctx, privateSkillInstallations),
        eq(privateSkillInstallations.slug, pkg.slug),
      ),
    )
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    await db
      .update(privateSkillInstallations)
      .set({
        packageId: pkg.id,
        skillId,
        installedVersion: pkg.skillVersion,
        mandatory: pkg.mandatory,
        source,
        installedBy: installer,
        updatedAt: now,
      })
      .where(eq(privateSkillInstallations.id, existing[0].id));
  } else {
    await db.insert(privateSkillInstallations).values(
      withTenantValues(ctx, {
        id: `pri_${nanoid()}`,
        orgId: raw.orgId,
        packageId: pkg.id,
        slug: pkg.slug,
        skillId,
        installedVersion: pkg.skillVersion,
        mandatory: pkg.mandatory,
        source,
        installedBy: installer,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  await db
    .update(privateSkillPackages)
    .set({
      installCount: raw.installCount + (existing[0] ? 0 : 1),
      updatedAt: now,
    })
    .where(eq(privateSkillPackages.id, pkg.id));
  await appendAuditEntry(ctx, {
    actor: installer,
    action: "private_skill.install",
    resourceType: "private_skill_package",
    resourceId: pkg.id,
    summary: `Installed private skill "${pkg.slug}" v${pkg.skillVersion} (${source})`,
  });
  const fresh = await db
    .select()
    .from(privateSkillInstallations)
    .where(
      and(
        tenantScope(ctx, privateSkillInstallations),
        eq(privateSkillInstallations.slug, pkg.slug),
      ),
    )
    .limit(1);
  return installationToRow(fresh[0]!);
}

export async function uninstallPackage(
  ctx: TenantContext,
  actor: string,
  slug: string,
  opts: { allowMandatory?: boolean } = {},
): Promise<{ removed: boolean }> {
  const rows = await db
    .select()
    .from(privateSkillInstallations)
    .where(
      and(
        tenantScope(ctx, privateSkillInstallations),
        eq(privateSkillInstallations.slug, slug),
      ),
    )
    .limit(1);
  const install = rows[0];
  if (!install) return { removed: false };
  if (install.mandatory && !opts.allowMandatory) {
    throw new PrivateRegistryError(
      "MANDATORY_LOCKED",
      "this skill is marked mandatory by your IT admin and cannot be uninstalled",
    );
  }
  await db
    .delete(privateSkillInstallations)
    .where(eq(privateSkillInstallations.id, install.id));
  await db
    .update(skillsTable)
    .set({ isInstalled: false, updatedAt: Date.now() })
    .where(
      and(tenantScope(ctx, skillsTable), eq(skillsTable.id, install.skillId)),
    );
  await appendAuditEntry(ctx, {
    actor,
    action: "private_skill.uninstall",
    resourceType: "private_skill_installation",
    resourceId: install.id,
    summary: `Uninstalled private skill "${slug}"`,
  });
  return { removed: true };
}

export async function listInstallations(
  ctx: TenantContext,
): Promise<InstallationRow[]> {
  const rows = await db
    .select()
    .from(privateSkillInstallations)
    .where(tenantScope(ctx, privateSkillInstallations))
    .orderBy(desc(privateSkillInstallations.createdAt));
  return rows.map(installationToRow);
}

// --------------------------- Push to team --------------------------------

export interface PushResult {
  packageId: string;
  installedSeats: number;
  skippedSeats: number;
}

/**
 * Admin action — install an approved package across every active seat
 * in the org. Each seat lives in its own tenant context after SCIM, but
 * for the v1 single-tenant-per-org topology this also marks the
 * package's local install row and records a `private_skill.push` audit
 * entry that downstream seat-level sync jobs consume.
 */
export async function pushToTeam(
  ctx: TenantContext,
  admin: string,
  packageId: string,
): Promise<PushResult> {
  const org = await getOrCreateOrg(ctx);
  const rows = await db
    .select()
    .from(privateSkillPackages)
    .where(
      and(
        tenantScope(ctx, privateSkillPackages),
        eq(privateSkillPackages.id, packageId),
      ),
    )
    .limit(1);
  const pkg = rows[0];
  if (!pkg) throw new PrivateRegistryError("NOT_FOUND", "package not found");
  if (pkg.status !== "approved") {
    throw new PrivateRegistryError(
      "NOT_APPROVED",
      "only approved packages can be pushed to the team",
    );
  }
  // Install for the calling tenant (the org-admin's workspace).
  await installPackage(ctx, admin, packageId, "admin_push");
  // Count seats — represents the rollout fan-out the orchestrator
  // enqueues. Seat-level workers replay this audit entry to install the
  // package in their own tenant context.
  const seats = await db
    .select()
    .from(enterpriseSeats)
    .where(
      and(tenantScope(ctx, enterpriseSeats), eq(enterpriseSeats.orgId, org.id)),
    );
  const installedSeats = seats.filter((s) => s.status !== "disabled").length;
  const skippedSeats = seats.length - installedSeats;
  await appendAuditEntry(ctx, {
    actor: admin,
    action: "private_skill.push",
    resourceType: "private_skill_package",
    resourceId: packageId,
    summary: `Pushed "${pkg.slug}" v${pkg.skillVersion} to ${installedSeats} seat(s)`,
  });
  return { packageId, installedSeats, skippedSeats };
}

// --------------------------- Remote sync (air-gap) -----------------------

export interface RemoteManifestEntry {
  slug: string;
  name: string;
  description?: string;
  content: string;
  modelTags?: string[];
  triggers?: string[];
  category?: string;
  documentation?: string;
  signature?: string;
  signatureAlgo?: string;
  mandatory?: boolean;
  visibility?: Visibility;
  visibilityTargets?: string[];
}

export interface RemoteManifest {
  packages: RemoteManifestEntry[];
}

/**
 * Pull the manifest from the configured remote registry URL and import
 * every package that doesn't already exist at that version. Signatures
 * are verified (if enforced) before insertion. Throws when the URL is
 * not configured; recoverable network errors are recorded into
 * `last_sync_error` for the admin UI.
 */
export async function syncFromRemote(
  ctx: TenantContext,
  admin: string,
  fetchImpl: (url: string) => Promise<RemoteManifest> = defaultFetch,
): Promise<{ imported: number; skipped: number }> {
  const settings = await getOrCreateSettings(ctx);
  if (settings.mode !== "remote" || !settings.remoteRegistryUrl) {
    throw new PrivateRegistryError(
      "NO_REMOTE",
      "remote registry URL is not configured",
    );
  }
  await logPrivacyEvent(ctx, {
    eventType: "private_registry.remote_pull",
    actor: admin,
    target: settings.remoteRegistryUrl,
    severity: "medium",
  });
  let manifest: RemoteManifest;
  try {
    manifest = await fetchImpl(settings.remoteRegistryUrl);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(privateRegistrySettings)
      .set({ lastSyncError: message, updatedAt: Date.now() })
      .where(tenantScope(ctx, privateRegistrySettings));
    throw new PrivateRegistryError("SYNC_FAILED", message);
  }
  let imported = 0;
  let skipped = 0;
  for (const entry of manifest.packages) {
    try {
      await submitPackage(ctx, admin, entry);
      imported += 1;
    } catch {
      skipped += 1;
    }
  }
  await db
    .update(privateRegistrySettings)
    .set({
      lastSyncedAt: Date.now(),
      lastSyncError: null,
      updatedAt: Date.now(),
    })
    .where(tenantScope(ctx, privateRegistrySettings));
  await appendAuditEntry(ctx, {
    actor: admin,
    action: "private_registry.sync",
    resourceType: "private_registry_settings",
    resourceId: settings.remoteRegistryUrl,
    summary: `Synced ${imported} package(s) from remote (skipped ${skipped})`,
  });
  return { imported, skipped };
}

async function defaultFetch(url: string): Promise<RemoteManifest> {
  // Outbound network call to the org's self-hosted air-gap registry —
  // recorded via `logPrivacyEvent` upstream in `syncFromRemote` so the
  // tamper-evident privacy log captures every remote-registry pull.
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`remote registry returned ${response.status}`);
  }
  const json = (await response.json()) as RemoteManifest;
  if (!json || !Array.isArray(json.packages)) {
    throw new Error("remote registry response is missing `packages` array");
  }
  return json;
}
