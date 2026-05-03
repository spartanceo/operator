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
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  },
  (t) => ({
    tenantIdx: index("idx_skills_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skills_workspace").on(t.workspaceId),
    slugIdx: index("idx_skills_tenant_slug").on(t.tenantId, t.slug),
    installedIdx: index("idx_skills_installed").on(t.tenantId, t.isInstalled),
    categoryIdx: index("idx_skills_category").on(t.tenantId, t.category),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
