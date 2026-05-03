/**
 * `support_response_templates` — saved canned-response snippets the OP
 * team can paste into a ticket reply.
 *
 * Mutable record — `version` column required.
 * Templates are stored under the SYSTEM tenant (the OP team is global),
 * but the table follows the standard tenant_id contract for tier-review.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const supportResponseTemplates = sqliteTable(
  "support_response_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    label: text("label").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull().default("general"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_support_response_templates_tenant").on(t.tenantId),
    workspaceIdx: index("idx_support_response_templates_workspace").on(t.workspaceId),
    categoryIdx: index("idx_support_response_templates_category").on(t.category),
  }),
);

export type SupportResponseTemplate = typeof supportResponseTemplates.$inferSelect;
export type NewSupportResponseTemplate = typeof supportResponseTemplates.$inferInsert;
