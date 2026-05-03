/**
 * `app_mcp_connections` — Model Context Protocol connector state per app.
 *
 * When an app publishes an MCP server (Linear, Notion, Figma, GitHub …),
 * a single one-click flow connects it. The declared tools are mirrored
 * into `app_capability_commands` with `source = 'mcp'` so the agent can
 * query them through the same path it uses for OS-native commands.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { appProfiles } from "./app-profiles";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const appMcpConnections = sqliteTable(
  "app_mcp_connections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    appProfileId: text("app_profile_id").notNull().references(() => appProfiles.id),
    endpoint: text("endpoint").notNull(),
    /** "available" | "connected" | "error" | "disconnected". */
    status: text("status").notNull().default("available"),
    /** JSON-encoded MCP tool list (name, description, inputSchema). */
    toolsJson: text("tools_json"),
    error: text("error"),
    connectedAt: integer("connected_at"),
    disconnectedAt: integer("disconnected_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_app_mcp_tenant").on(t.tenantId),
    workspaceIdx: index("idx_app_mcp_workspace").on(t.workspaceId),
    profileIdx: index("idx_app_mcp_profile").on(t.appProfileId),
    statusIdx: index("idx_app_mcp_status").on(t.tenantId, t.status),
  }),
);

export type AppMcpConnection = typeof appMcpConnections.$inferSelect;
export type NewAppMcpConnection = typeof appMcpConnections.$inferInsert;
