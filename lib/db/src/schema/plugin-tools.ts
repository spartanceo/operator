/**
 * `plugin_tools` — custom tools registered via the Developer SDK.
 *
 * Each row defines a tool the agent loop is allowed to call alongside
 * the built-in tool catalogue. The `inputSchema` is a JSON-Schema
 * fragment the API server validates against before forwarding the call
 * to the sidecar at `invokeUrl`. `riskLevel` drives the approval gate
 * (medium+ pauses for user approval, identical to built-in tools).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const pluginTools = sqliteTable(
  "plugin_tools",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    riskLevel: text("risk_level").notNull().default("medium"),
    /** JSON-encoded JSON-Schema fragment for the tool's input. */
    inputSchema: text("input_schema").notNull().default("{}"),
    invokeUrl: text("invoke_url").notNull(),
    authToken: text("auth_token"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_plugin_tools_tenant").on(t.tenantId),
    workspaceIdx: index("idx_plugin_tools_workspace").on(t.workspaceId),
    nameIdx: uniqueIndex("idx_plugin_tools_tenant_name").on(t.tenantId, t.name),
  }),
);

export type PluginTool = typeof pluginTools.$inferSelect;
export type NewPluginTool = typeof pluginTools.$inferInsert;
