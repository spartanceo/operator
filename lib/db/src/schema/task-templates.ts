/**
 * `task_templates` — reusable, parameterised task prompts (Task #46).
 *
 * A template captures everything needed to re-run a task:
 *   - `prompt`        — the prompt text. May contain `{{varName}}` tokens.
 *   - `variables`     — JSON array of declared variables: name, label,
 *                       optional defaultValue, required flag.
 *   - `skillConfig`   — JSON snapshot of the agent/skill configuration the
 *                       template should run with: model, agentMode, etc.
 *   - `categoryId`    — optional `task_template_categories` membership.
 *   - `pinnedOrder`   — when non-null, the template is pinned to the
 *                       quick-launch row. Capped at 5 per workspace by
 *                       `task-templates.service.ts`.
 *   - `usageCount`    / `lastUsedAt` — bumped each time the template runs.
 *   - `sourceRunId`   — optional reference to the agent run the user saved
 *                       the template from (audit / "open original" UX).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { taskTemplateCategories } from "./task-template-categories";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const taskTemplates = sqliteTable(
  "task_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    categoryId: text("category_id").references(() => taskTemplateCategories.id),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt").notNull(),
    variables: text("variables").notNull().default("[]"),
    skillConfig: text("skill_config").notNull().default("{}"),
    pinnedOrder: integer("pinned_order"),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: integer("last_used_at"),
    sourceRunId: text("source_run_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_task_templates_tenant").on(t.tenantId),
    workspaceIdx: index("idx_task_templates_workspace").on(
      t.tenantId,
      t.workspaceId,
    ),
    categoryIdx: index("idx_task_templates_category").on(
      t.tenantId,
      t.categoryId,
    ),
    pinnedIdx: index("idx_task_templates_pinned").on(
      t.tenantId,
      t.workspaceId,
      t.pinnedOrder,
    ),
    lastUsedIdx: index("idx_task_templates_last_used").on(
      t.tenantId,
      t.lastUsedAt,
    ),
  }),
);

export type TaskTemplate = typeof taskTemplates.$inferSelect;
export type NewTaskTemplate = typeof taskTemplates.$inferInsert;
