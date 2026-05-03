/**
 * `conversations` — multi-thread chat / agent conversation containers.
 *
 * Each conversation groups a sequence of `messages` and any `agent_runs`
 * the user kicked off from inside that thread. Conversations are the unit
 * the user navigates ("New conversation", pin, archive, delete) — every
 * message and run carries an optional `conversation_id` foreign key so
 * historic data (predating multi-conversation) keeps loading without an
 * ambient thread.
 *
 * State columns:
 *   - `pinned` / `pinnedAt`         : sticky-to-top flag with timestamp.
 *   - `archived` / `archivedAt`     : hidden from the default list, still
 *                                     restorable / searchable.
 *   - `lastMessageAt` / `…Preview`  : denormalised so the sidebar list can
 *                                     render without a join.
 *   - `messageCount`                : maintained by the conversation service
 *                                     when messages are appended.
 *   - `desktopUsed`                 : flipped true when any tool call inside
 *                                     a run on this conversation came from
 *                                     the desktop control surface — drives
 *                                     the "desktop control was involved"
 *                                     filter from Task #41.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id"),
    title: text("title").notNull(),
    summary: text("summary"),
    pinned: integer("pinned").notNull().default(0),
    pinnedAt: integer("pinned_at"),
    archived: integer("archived").notNull().default(0),
    archivedAt: integer("archived_at"),
    lastMessageAt: integer("last_message_at"),
    lastMessagePreview: text("last_message_preview"),
    messageCount: integer("message_count").notNull().default(0),
    agentMode: integer("agent_mode").notNull().default(0),
    modelName: text("model_name"),
    desktopUsed: integer("desktop_used").notNull().default(0),
    summarisedThroughTs: integer("summarised_through_ts"),
    contextResetTs: integer("context_reset_ts"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_conversations_tenant").on(t.tenantId),
    workspaceIdx: index("idx_conversations_workspace").on(t.workspaceId),
    pinnedIdx: index("idx_conversations_pinned").on(t.tenantId, t.pinned),
    archivedIdx: index("idx_conversations_archived").on(t.tenantId, t.archived),
    lastMsgIdx: index("idx_conversations_last_msg").on(t.tenantId, t.lastMessageAt),
  }),
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
