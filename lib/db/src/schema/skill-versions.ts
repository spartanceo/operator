/**
 * `skill_versions` — immutable per-version history for every published
 * skill. One row per (skill, semver). Backs the "version history" tab,
 * rollback flow, and per-version adoption stats (install_count is
 * incremented every time an installed skill is moved to that version).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { skills } from "./skills";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillVersions = sqliteTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    /** Semantic version string e.g. "1.2.3". */
    semver: text("semver").notNull(),
    /** Numeric sort key derived from the semver — stable ORDER BY. */
    sortKey: integer("sort_key").notNull(),
    changelog: text("changelog").notNull().default(""),
    breakingChange: integer("breaking_change", { mode: "boolean" })
      .notNull()
      .default(false),
    minOpVersion: text("min_op_version").notNull().default("0.0.0"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    content: text("content").notNull().default(""),
    modelTags: text("model_tags").notNull().default("[]"),
    triggers: text("triggers").notNull().default("[]"),
    category: text("category").notNull().default("Productivity"),
    author: text("author").notNull().default("local"),
    installCount: integer("install_count").notNull().default(0),
    /** Snapshot of the skill's configuration schema at this version. */
    configurationSchema: text("configuration_schema").notNull().default("[]"),
    /** Snapshot of `skills.execution_manifest` at publish time (Task #39). */
    executionManifest: text("execution_manifest"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_versions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_versions_workspace").on(t.tenantId, t.workspaceId),
    skillIdx: index("idx_skill_versions_skill").on(t.tenantId, t.skillId),
    skillSemverIdx: uniqueIndex("idx_skill_versions_skill_semver").on(
      t.tenantId,
      t.skillId,
      t.semver,
    ),
  }),
);

export type SkillVersion = typeof skillVersions.$inferSelect;
export type NewSkillVersion = typeof skillVersions.$inferInsert;
