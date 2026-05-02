/**
 * Migration 0014 — multi-conversation management (Task #41).
 *
 * Adds the `conversations` table and back-fills nullable `conversation_id`
 * columns on `messages` and `agent_runs`. The columns are nullable on
 * purpose: pre-existing transcripts written before this migration have no
 * thread, and the conversation service treats null `conversation_id` as
 * "legacy / orphan" — they remain searchable but are not surfaced in the
 * sidebar list.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_id TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    last_message_at INTEGER,
    last_message_preview TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    agent_mode INTEGER NOT NULL DEFAULT 0,
    model_name TEXT,
    desktop_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(tenant_id, pinned);
  CREATE INDEX IF NOT EXISTS idx_conversations_archived ON conversations(tenant_id, archived);
  CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON conversations(tenant_id, last_message_at);

  ALTER TABLE messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

  ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id);
`;

// SQLite cannot DROP COLUMN on older builds — for the rollback we drop the
// dependent table only. The two add-columns are no-ops once the parent is
// gone (queries can never reach them again because the FK target is gone).
const down = `
  DROP INDEX IF EXISTS idx_agent_runs_conversation;
  DROP INDEX IF EXISTS idx_messages_conversation;
  DROP TABLE IF EXISTS conversations;
`;

export const migration: SchemaMigration = {
  id: 14,
  name: "conversations",
  up,
  down,
};
