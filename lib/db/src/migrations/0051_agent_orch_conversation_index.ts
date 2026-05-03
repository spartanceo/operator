/**
 * Migration 0051 — backfill the missing `idx_agent_orch_conversation` index.
 *
 * Task #50 added `agent_orchestrations.conversation_id` with a foreign key
 * (`.references(() => conversations.id)`) but no covering index, which the
 * tier-review schema linter flags under Standard 13. This migration adds the
 * index and the matching schema entry; no data change.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE INDEX IF NOT EXISTS idx_agent_orch_conversation
    ON agent_orchestrations(conversation_id);
`;

const down = `
  DROP INDEX IF EXISTS idx_agent_orch_conversation;
`;

export const migration: SchemaMigration = {
  id: 51,
  name: "agent_orch_conversation_index",
  up,
  down,
};
