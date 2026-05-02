/**
 * `kb_documents` — one row per ingested artefact in the personal knowledge
 * base. Stores the original text plus metadata used for the documents list
 * UI. Per-chunk embeddings live in `kb_chunks` so the vector search can
 * scan many small rows without re-decoding the whole document body.
 *
 * `contentHash` is the sha256 of the normalised body — used for duplicate
 * detection on ingest (the service warns/refuses near-identical content).
 *
 * `sourceType` is one of `text`, `url`, `file`, `youtube` — informational
 * only at the schema layer; the service decides which parser ran.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";
import { kbCollections } from "./kb-collections";

export const kbDocuments = sqliteTable(
  "kb_documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    collectionId: text("collection_id").references(() => kbCollections.id),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull().default("text"),
    sourceUri: text("source_uri"),
    mimeType: text("mime_type"),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    tags: text("tags").notNull().default("[]"),
    summary: text("summary"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_kb_documents_tenant").on(t.tenantId),
    workspaceIdx: index("idx_kb_documents_workspace").on(t.workspaceId),
    collectionIdx: index("idx_kb_documents_collection").on(t.collectionId),
    hashIdx: index("idx_kb_documents_hash").on(t.tenantId, t.contentHash),
    sourceIdx: index("idx_kb_documents_source").on(t.tenantId, t.sourceType),
  }),
);

export type KbDocument = typeof kbDocuments.$inferSelect;
export type NewKbDocument = typeof kbDocuments.$inferInsert;
