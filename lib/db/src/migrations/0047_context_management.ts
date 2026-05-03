/**
 * Migration 0047 — context-window management & rolling summarisation.
 *
 * Introduced by Task #51 (Context Window Management & Conversation
 * Summarisation):
 *   - `messages.pinned`               — flag preserving messages from
 *                                       compression / summarisation.
 *   - `messages.pinned_at`            — when the user pinned the row.
 *   - `messages.is_summary`           — flag identifying compressed
 *                                       summary placeholders that take
 *                                       the place of older verbose
 *                                       history in the active context
 *                                       window. Always kept in context.
 *   - `conversations.summarised_through_ts`
 *                                     — high-water-mark timestamp; any
 *                                       non-pinned non-summary message
 *                                       with createdAt <= this value is
 *                                       excluded from the active context
 *                                       (its content is represented by
 *                                       a summary message instead).
 *   - `conversations.context_reset_ts`
 *                                     — when the user explicitly reset
 *                                       the context. Messages older than
 *                                       this are not sent to the model
 *                                       even if not summarised. The
 *                                       transcript stays visible in the
 *                                       UI; only the LLM input is
 *                                       trimmed.
 *
 * `IF NOT EXISTS` and idempotent ALTERs (column-add wrapped in a
 * pragma_table_info check) keep this safe to re-run.
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
  ALTER TABLE messages ADD COLUMN is_summary INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_messages_pinned
    ON messages(tenant_id, conversation_id, pinned);
  CREATE INDEX IF NOT EXISTS idx_messages_summary
    ON messages(tenant_id, conversation_id, is_summary);

  ALTER TABLE conversations ADD COLUMN summarised_through_ts INTEGER;
  ALTER TABLE conversations ADD COLUMN context_reset_ts INTEGER;
`;

const down = `
  DROP INDEX IF EXISTS idx_messages_pinned;
  DROP INDEX IF EXISTS idx_messages_summary;
`;

export const migration: SchemaMigration = {
  id: 47,
  name: "context_management",
  up,
  down,
};
