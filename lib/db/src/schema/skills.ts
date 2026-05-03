/**
 * `skills` — community-built skill packages for the local Skills Marketplace.
 *
 * A skill is a small, named instruction-set tagged to one or more local
 * models. Users browse, install, import (.skill JSON file), export, and
 * invoke skills inside the deterministic agent pipeline.
 *
 * Multi-tenant: every row is scoped by `tenantId` + `workspaceId` so two
 * tenants can publish the same slug without collision.
 *
 * `modelTags` is a JSON-encoded string array of model names the skill is
 * compatible with (e.g. ["llama3.1", "qwen2.5"]). The Router agent uses
 * these tags + `triggers` to decide whether a skill should be injected
 * into a run.
 */
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    content: text("content").notNull().default(""),
    /** JSON-encoded string array of compatible model names. */
    modelTags: text("model_tags").notNull().default("[]"),
    /** JSON-encoded string array of trigger words/phrases for the Router. */
    triggers: text("triggers").notNull().default("[]"),
    category: text("category").notNull().default("Productivity"),
    author: text("author").notNull().default("local"),
    isInstalled: integer("is_installed", { mode: "boolean" })
      .notNull()
      .default(false),
    installCount: integer("install_count").notNull().default(0),
    /** Latest published semver, e.g. "1.2.0". */
    latestVersion: text("latest_version").notNull().default("1.0.0"),
    /** Currently installed semver — may lag latestVersion. */
    installedVersion: text("installed_version").notNull().default("1.0.0"),
    /** Changelog entry for the latest published version. */
    changelog: text("changelog").notNull().default(""),
    /** True iff the latest version was flagged as a breaking change. */
    breakingChange: integer("breaking_change", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Minimum OP version required by the latest published version. */
    minOpVersion: text("min_op_version").notNull().default("0.0.0"),
    /** When set the user opted into auto-applying non-breaking updates. */
    autoUpdate: integer("auto_update", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Wall-clock of the last publish — drives "Unmaintained" trust signal. */
    publishedAt: integer("published_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** If the user dismissed an update card the dismissed semver lives here. */
    updateDismissedVersion: text("update_dismissed_version"),
    /** Total successful invocations — drives "Used N times" social proof. */
    usageCount: integer("usage_count").notNull().default(0),
    /** Cached average of `skill_ratings.stars` for active rows. */
    ratingAvg: real("rating_avg").notNull().default(0),
    /** Number of active reviews counted in `ratingAvg`. */
    ratingCount: integer("rating_count").notNull().default(0),
    /** Editorial "OP Pick" curation flag. */
    editorialPick: integer("editorial_pick", { mode: "boolean" })
      .notNull()
      .default(false),
    /** "Verified by OP" trust badge — set after OP team manual review. */
    verifiedByOp: integer("verified_by_op", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Last time we notified the creator about a low-rating drop. */
    lowRatingAlertAt: integer("low_rating_alert_at"),
    /** Premium skills require a creator-pro subscription past their preview allowance. */
    isPremium: integer("is_premium", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Free invocations granted before the paywall kicks in. Default = 2 (Task #6). */
    previewUsesAllowed: integer("preview_uses_allowed").notNull().default(2),
    /**
     * JSON-encoded array of `ConfigField` declarations (Task #43). Empty
     * array means the skill has no user-supplied configuration and the
     * first-run gate is bypassed.
     */
    configurationSchema: text("configuration_schema").notNull().default("[]"),
    /**
     * JSON-encoded `SkillExecutionManifest` (Task #39). Nullable for
     * skills authored before the contract existed; the runtime treats
     * NULL as "legacy text-prompt skill" and routes it through the
     * deterministic agent loop.
     */
    executionManifest: text("execution_manifest"),
  },
  (t) => ({
    tenantIdx: index("idx_skills_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skills_workspace").on(t.workspaceId),
    slugIdx: index("idx_skills_tenant_slug").on(t.tenantId, t.slug),
    installedIdx: index("idx_skills_installed").on(t.tenantId, t.isInstalled),
    categoryIdx: index("idx_skills_category").on(t.tenantId, t.category),
    ratingIdx: index("idx_skills_rating").on(t.tenantId, t.ratingAvg),
    usageIdx: index("idx_skills_usage").on(t.tenantId, t.usageCount),
    updatedIdx: index("idx_skills_updated").on(t.tenantId, t.updatedAt),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
