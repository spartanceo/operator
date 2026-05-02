/**
 * Migration 0002 — knowledge base.
 *
 * Adds the three tables that back Task #12's Personal Knowledge Base:
 *   - kb_collections — user-defined groupings (name, description, colour)
 *   - kb_documents   — ingested artifacts (text / url / youtube), with
 *                      sha256 content_hash for dedupe and a JSON tags array
 *   - kb_chunks      — sentence-aware splits of each document, each carrying
 *                      a JSON-encoded float embedding vector for the local
 *                      hash-bucket TF-IDF retriever
 *
 * Tenant safety: every table carries `tenant_id` + `workspace_id` and the
 * indexes mirror the access patterns enforced by `tenantScope` (per-tenant
 * scans, content-hash dedupe, collection / document fan-out).
 *
 * The down script drops them in reverse FK order so `rollbackTo(1)` cleanly
 * restores the baseline schema.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS kb_collections (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT,
    color TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_kb_collections_tenant ON kb_collections(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_kb_collections_workspace ON kb_collections(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_kb_collections_name ON kb_collections(tenant_id, name);

  CREATE TABLE IF NOT EXISTS kb_documents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    collection_id TEXT REFERENCES kb_collections(id),
    title TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text',
    source_uri TEXT,
    mime_type TEXT,
    body TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_kb_documents_tenant ON kb_documents(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_kb_documents_workspace ON kb_documents(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_kb_documents_collection ON kb_documents(collection_id);
  CREATE INDEX IF NOT EXISTS idx_kb_documents_hash ON kb_documents(tenant_id, content_hash);
  CREATE INDEX IF NOT EXISTS idx_kb_documents_source ON kb_documents(tenant_id, source_type);

  CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    document_id TEXT NOT NULL REFERENCES kb_documents(id),
    position INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    embedding TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant ON kb_chunks(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_workspace ON kb_chunks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_document ON kb_chunks(document_id);
`;

const down = `
  DROP TABLE IF EXISTS kb_chunks;
  DROP TABLE IF EXISTS kb_documents;
  DROP TABLE IF EXISTS kb_collections;
`;

export const migration: SchemaMigration = {
  id: 6,
  name: "knowledge_base",
  up,
  down,
};
