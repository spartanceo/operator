/**
 * Enterprise Private Skill Registry (Task #60).
 *
 * Three tables that back an organisation-internal skill registry that
 * never appears on the public marketplace:
 *
 *   - `privateRegistrySettings` — per-org config (mode, remote URL,
 *     signing public key, signature enforcement).
 *   - `privateSkillPackages` — versioned internal skills, scoped to one
 *     enterprise org. Carries IT-admin approval status, visibility
 *     scope (all / roles / workspaces) and an optional `mandatory`
 *     flag.
 *   - `privateSkillInstallations` — per-tenant install record linking
 *     the published package to the local `skills` row that the agent
 *     loop consumes.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const privateRegistrySettings = sqliteTable(
  "private_registry_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    /** `local` (co-hosted) or `remote` (self-hosted air-gap server). */
    mode: text("mode").notNull().default("local"),
    remoteRegistryUrl: text("remote_registry_url"),
    signingPublicKeyPem: text("signing_public_key_pem"),
    requireSignature: integer("require_signature", { mode: "boolean" })
      .notNull()
      .default(false),
    lastSyncedAt: integer("last_synced_at"),
    lastSyncError: text("last_sync_error"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_private_registry_settings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_private_registry_settings_workspace").on(t.workspaceId),
    orgIdx: index("idx_private_registry_settings_org").on(t.orgId),
    orgUniqueIdx: uniqueIndex("uq_private_registry_settings_org").on(t.orgId),
  }),
);

export type PrivateRegistrySetting =
  typeof privateRegistrySettings.$inferSelect;
export type NewPrivateRegistrySetting =
  typeof privateRegistrySettings.$inferInsert;

export const privateSkillPackages = sqliteTable(
  "private_skill_packages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    content: text("content").notNull().default(""),
    /** JSON-encoded string array of compatible model names. */
    modelTags: text("model_tags").notNull().default("[]"),
    /** JSON-encoded array of trigger phrases. */
    triggers: text("triggers").notNull().default("[]"),
    category: text("category").notNull().default("Internal"),
    documentation: text("documentation").notNull().default(""),
    skillVersion: integer("skill_version").notNull().default(1),
    isLatest: integer("is_latest", { mode: "boolean" })
      .notNull()
      .default(true),
    /** `all` | `roles` | `workspaces`. */
    visibility: text("visibility").notNull().default("all"),
    /** JSON array of role names or workspace ids depending on visibility. */
    visibilityTargets: text("visibility_targets").notNull().default("[]"),
    mandatory: integer("mandatory", { mode: "boolean" })
      .notNull()
      .default(false),
    /** `pending` | `approved` | `rejected` | `superseded`. */
    status: text("status").notNull().default("pending"),
    submittedBy: text("submitted_by").notNull().default(""),
    submittedAt: integer("submitted_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    reviewedBy: text("reviewed_by").notNull().default(""),
    reviewedAt: integer("reviewed_at"),
    reviewNotes: text("review_notes").notNull().default(""),
    rejectionReason: text("rejection_reason").notNull().default(""),
    signature: text("signature").notNull().default(""),
    signatureAlgo: text("signature_algo").notNull().default(""),
    installCount: integer("install_count").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_private_skill_packages_tenant").on(t.tenantId),
    workspaceIdx: index("idx_private_skill_packages_workspace").on(t.workspaceId),
    orgIdx: index("idx_private_skill_packages_org").on(t.orgId),
    statusIdx: index("idx_private_skill_packages_status").on(t.status),
    latestIdx: index("idx_private_skill_packages_latest").on(t.orgId, t.isLatest),
    slugVersionIdx: uniqueIndex("uq_private_skill_packages_slug_version").on(
      t.orgId,
      t.slug,
      t.skillVersion,
    ),
  }),
);

export type PrivateSkillPackage = typeof privateSkillPackages.$inferSelect;
export type NewPrivateSkillPackage = typeof privateSkillPackages.$inferInsert;

export const privateSkillInstallations = sqliteTable(
  "private_skill_installations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    packageId: text("package_id")
      .notNull()
      .references(() => privateSkillPackages.id),
    slug: text("slug").notNull(),
    skillId: text("skill_id").notNull(),
    installedVersion: integer("installed_version").notNull(),
    mandatory: integer("mandatory", { mode: "boolean" })
      .notNull()
      .default(false),
    /** `user` (member-initiated) or `admin_push` (admin-mandated rollout). */
    source: text("source").notNull().default("user"),
    installedBy: text("installed_by").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_private_skill_installations_tenant").on(t.tenantId),
    workspaceIdx: index("idx_private_skill_installations_workspace").on(
      t.workspaceId,
    ),
    orgIdx: index("idx_private_skill_installations_org").on(t.orgId),
    packageIdx: index("idx_private_skill_installations_package").on(t.packageId),
    skillIdx: index("idx_private_skill_installations_skill").on(t.skillId),
    pairIdx: uniqueIndex("uq_private_skill_installations_pair").on(
      t.tenantId,
      t.workspaceId,
      t.slug,
    ),
  }),
);

export type PrivateSkillInstallation =
  typeof privateSkillInstallations.$inferSelect;
export type NewPrivateSkillInstallation =
  typeof privateSkillInstallations.$inferInsert;
