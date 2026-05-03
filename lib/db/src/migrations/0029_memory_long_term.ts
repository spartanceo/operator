/**
 * Migration 0027 — Long-term memory & user preference learning (Task #49).
 *
 * Extends the `memories` table from a flat title/content/importance store
 * into a structured long-term memory model:
 *
 *   - `category`               : fact | preference | pattern | contact | project
 *                                — coarse bucket the Memory panel filters on.
 *   - `confidence`             : confirmed | observed | inferred — how much
 *                                weight retrieval should give the entry.
 *   - `source_conversation_id` : nullable FK to the conversation the entry
 *                                was extracted from (null for user-authored
 *                                or seed entries).
 *   - `last_accessed_at`       : touched every time the retriever surfaces
 *                                the entry — feeds the LRU pruning weight.
 *   - `access_count`           : monotonic counter — same purpose.
 *   - `pinned`                 : when true the prune policy will never evict.
 *
 * Adds `memory_settings` — singleton-per-tenant: capacity cap, last-prune
 * timestamp, and the irreversible `forgotten_at` "nuclear option" stamp the
 * privacy dashboard writes when the user hits "Forget everything about me".
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'fact';
  ALTER TABLE memories ADD COLUMN confidence TEXT NOT NULL DEFAULT 'confirmed';
  ALTER TABLE memories ADD COLUMN source_conversation_id TEXT REFERENCES conversations(id);
  ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER;
  ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(tenant_id, category);
  CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(tenant_id, confidence);
  CREATE INDEX IF NOT EXISTS idx_memories_workspace_category ON memories(workspace_id, category);
  CREATE INDEX IF NOT EXISTS idx_memories_source_conv ON memories(source_conversation_id);

  CREATE TABLE IF NOT EXISTS memory_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    capacity_bytes INTEGER NOT NULL DEFAULT 52428800,
    auto_extract INTEGER NOT NULL DEFAULT 1,
    last_pruned_at INTEGER,
    forgotten_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_memory_settings_tenant ON memory_settings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_memory_settings_workspace ON memory_settings(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_settings_tenant_unique ON memory_settings(tenant_id);
`;

const down = `
  DROP TABLE IF EXISTS memory_settings;
`;

export const migration: SchemaMigration = {
  id: 29,
  name: "memory_long_term",
  up,
  down,
};
