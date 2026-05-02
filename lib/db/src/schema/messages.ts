/**
 * `messages` — conversation log (user / assistant / tool turns).
 *
 * Linked optionally to an `agent_runs.id` so messages produced inside a
 * task pipeline are recoverable from the run. `content` is JSON-encoded for
 * tool messages so we can carry structured payloads without schema drift.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { agentRuns } from "./agent-runs";
import { conversations } from "./conversations";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    conversationId: text("conversation_id").references(() => conversations.id),
    runId: text("run_id").references(() => agentRuns.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_messages_tenant").on(t.tenantId),
    workspaceIdx: index("idx_messages_workspace").on(t.workspaceId),
    runIdx: index("idx_messages_run").on(t.runId),
    conversationIdx: index("idx_messages_conversation").on(t.conversationId),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
