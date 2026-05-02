/**
 * `kb_collections` — named groups for knowledge-base documents (e.g.
 * "Client Research", "Competitor Analysis"). Each document optionally
 * belongs to one collection. Collections are tenant + workspace scoped.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const kbCollections = sqliteTable(
  "kb_collections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_kb_collections_tenant").on(t.tenantId),
    workspaceIdx: index("idx_kb_collections_workspace").on(t.workspaceId),
    nameIdx: index("idx_kb_collections_name").on(t.tenantId, t.name),
  }),
);

export type KbCollection = typeof kbCollections.$inferSelect;
export type NewKbCollection = typeof kbCollections.$inferInsert;
