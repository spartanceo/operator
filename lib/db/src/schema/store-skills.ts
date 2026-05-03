/**
 * `store_skills` — published skills in the hosted Skill Store.
 *
 * One row per (creator handle, slug, version). Newer versions create new
 * rows; the latest version is the one returned to browsers by default.
 * `installCount` is incremented atomically on every store install.
 *
 * Although the v1 store is co-hosted in the same API process, every row
 * still gets the canonical `tenantId` + `workspaceId` columns so the
 * multi-tenant helpers and tier-review checks keep applying. The "store"
 * is conceptually the system tenant — these rows are visible to every
 * tenant that browses the store.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { creatorAccounts } from "./creator-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const storeSkills = sqliteTable(
  "store_skills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
    creatorId: text("creator_id").notNull().references(() => creatorAccounts.id),
    creatorHandle: text("creator_handle").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    content: text("content").notNull().default(""),
    /** JSON-encoded array of compatible model names. */
    modelTags: text("model_tags").notNull().default("[]"),
    /** JSON-encoded array of trigger phrases. */
    triggers: text("triggers").notNull().default("[]"),
    /** JSON-encoded array of example prompts surfaced on the store page. */
    examplePrompts: text("example_prompts").notNull().default("[]"),
    category: text("category").notNull().default("Productivity"),
    /** Numeric version starting at 1; incremented on every publish of the same slug. */
    skillVersion: integer("skill_version").notNull().default(1),
    /** Latest version of this slug? Maintained by the publish service. */
    isLatest: integer("is_latest", { mode: "boolean" }).notNull().default(true),
    installCount: integer("install_count").notNull().default(0),
    /** Free-form documentation markdown the creator can attach. */
    documentation: text("documentation").notNull().default(""),
  },
  (t) => ({
    tenantIdx: index("idx_store_skills_tenant").on(t.tenantId),
    workspaceIdx: index("idx_store_skills_workspace").on(t.workspaceId),
    creatorIdx: index("idx_store_skills_creator").on(t.creatorId),
    creatorHandleIdx: index("idx_store_skills_creator_handle").on(t.creatorHandle),
    categoryIdx: index("idx_store_skills_category").on(t.category),
    latestSlugIdx: uniqueIndex("uq_store_skills_creator_slug_version").on(
      t.creatorHandle,
      t.slug,
      t.skillVersion,
    ),
    latestIdx: index("idx_store_skills_latest").on(t.isLatest),
  }),
);

export type StoreSkill = typeof storeSkills.$inferSelect;
export type NewStoreSkill = typeof storeSkills.$inferInsert;

/**
 * `store_installations` — local record of which store skill version a
 * tenant has installed. Used by the auto-update check to compare the
 * locally-installed version against the latest one in the store.
 */
export const storeInstallations = sqliteTable(
  "store_installations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Local skills.id row this install produced. */
    skillId: text("skill_id").notNull(),
    /** Stable store identity: creator + slug. */
    creatorHandle: text("creator_handle").notNull(),
    slug: text("slug").notNull(),
    /** Skill version installed. */
    installedVersion: integer("installed_version").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_store_installations_tenant").on(t.tenantId),
    workspaceIdx: index("idx_store_installations_workspace").on(t.workspaceId),
    skillIdx: index("idx_store_installations_skill").on(t.skillId),
    pairIdx: uniqueIndex("uq_store_installations_pair").on(
      t.tenantId,
      t.creatorHandle,
      t.slug,
    ),
  }),
);

export type StoreInstallation = typeof storeInstallations.$inferSelect;
export type NewStoreInstallation = typeof storeInstallations.$inferInsert;
