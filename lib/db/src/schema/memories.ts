/**
 * `memories` — long-lived user memories the agent surfaces back into
 * future runs.
 *
 * Task #49 extended the model from a flat title/content/importance store
 * into a structured long-term memory:
 *
 *   - `category`               : fact | preference | pattern | contact | project
 *   - `confidence`             : confirmed | observed | inferred — drives
 *                                how much weight the retriever assigns
 *                                each entry.
 *   - `sourceConversationId`   : nullable FK to the conversation the entry
 *                                was extracted from.
 *   - `lastAccessedAt` /
 *     `accessCount`            : touched on retrieval; feed the LRU
 *                                component of the pruning weight.
 *   - `pinned`                 : when true the prune policy will never
 *                                evict the row.
 *
 * Legacy `kind` column is preserved for back-compat with the original
 * Memory agent (Task #5) — the new `category` field is the canonical
 * surface for the Memory panel.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { conversations } from "./conversations";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull().default("fact"),
    category: text("category").notNull().default("fact"),
    confidence: text("confidence").notNull().default("confirmed"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    importance: integer("importance").notNull().default(50),
    source: text("source"),
    sourceConversationId: text("source_conversation_id").references(() => conversations.id),
    lastAccessedAt: integer("last_accessed_at"),
    accessCount: integer("access_count").notNull().default(0),
    pinned: integer("pinned").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_memories_tenant").on(t.tenantId),
    workspaceIdx: index("idx_memories_workspace").on(t.workspaceId),
    kindIdx: index("idx_memories_kind").on(t.tenantId, t.kind),
    categoryIdx: index("idx_memories_category").on(t.tenantId, t.category),
    confidenceIdx: index("idx_memories_confidence").on(t.tenantId, t.confidence),
    workspaceCategoryIdx: index("idx_memories_workspace_category").on(
      t.workspaceId,
      t.category,
    ),
    sourceConvIdx: index("idx_memories_source_conv").on(t.sourceConversationId),
  }),
);

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

export const memorySettings = sqliteTable(
  "memory_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    capacityBytes: integer("capacity_bytes").notNull().default(52_428_800),
    autoExtract: integer("auto_extract").notNull().default(1),
    lastPrunedAt: integer("last_pruned_at"),
    forgottenAt: integer("forgotten_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_memory_settings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_memory_settings_workspace").on(t.workspaceId),
  }),
);

export type MemorySettings = typeof memorySettings.$inferSelect;
export type NewMemorySettings = typeof memorySettings.$inferInsert;
