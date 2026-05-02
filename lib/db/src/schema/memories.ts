/**
 * `memories` — long-lived user memories the Memory agent surfaces back into
 * future runs. `kind` separates fact / preference / contact / project so the
 * Memory agent can rank by relevance.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull().default("fact"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    importance: integer("importance").notNull().default(50),
    source: text("source"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_memories_tenant").on(t.tenantId),
    workspaceIdx: index("idx_memories_workspace").on(t.workspaceId),
    kindIdx: index("idx_memories_kind").on(t.tenantId, t.kind),
  }),
);

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
