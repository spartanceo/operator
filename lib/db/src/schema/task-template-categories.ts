/**
 * `task_template_categories` — user-defined folders for organising
 * Task Templates (Task #46).
 *
 * Categories are scoped to a single workspace. They are entirely optional —
 * a template's `categoryId` is nullable so users who don't bother with
 * folders still get the full benefit of the template system.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const taskTemplateCategories = sqliteTable(
  "task_template_categories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    color: text("color"),
    icon: text("icon"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_task_template_categories_tenant").on(t.tenantId),
    workspaceIdx: index("idx_task_template_categories_workspace").on(
      t.tenantId,
      t.workspaceId,
    ),
  }),
);

export type TaskTemplateCategory = typeof taskTemplateCategories.$inferSelect;
export type NewTaskTemplateCategory =
  typeof taskTemplateCategories.$inferInsert;
