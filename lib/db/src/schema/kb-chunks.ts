/**
 * `kb_chunks` — embedded segments of a `kb_documents` row.
 *
 * The Tier 1 embedding pipeline is a deterministic local hash-bucket
 * vector (see `kb.service`); each chunk row holds:
 *   - `text`        — the raw chunk content used for snippet citations.
 *   - `embedding`   — a JSON-encoded `number[]` of fixed dimension.
 *   - `tokens`      — approximate token count, used for budget accounting.
 *   - `position`    — chunk index within the document (0-based).
 *
 * Storing the embedding as JSON keeps the schema dependency-free until the
 * sqlite-vec extension lands in a later tier; the service contract
 * (`embed()` + cosine similarity) does not change when that happens.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";
import { kbDocuments } from "./kb-documents";

export const kbChunks = sqliteTable(
  "kb_chunks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    documentId: text("document_id").notNull().references(() => kbDocuments.id),
    position: integer("position").notNull().default(0),
    text: text("text").notNull(),
    tokens: integer("tokens").notNull().default(0),
    embedding: text("embedding").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_kb_chunks_tenant").on(t.tenantId),
    workspaceIdx: index("idx_kb_chunks_workspace").on(t.workspaceId),
    documentIdx: index("idx_kb_chunks_document").on(t.documentId),
  }),
);

export type KbChunk = typeof kbChunks.$inferSelect;
export type NewKbChunk = typeof kbChunks.$inferInsert;
