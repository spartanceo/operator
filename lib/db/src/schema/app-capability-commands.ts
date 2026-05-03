/**
 * `app_capability_commands` — discrete capability rows for one app profile.
 *
 * Each row is a single scriptable command, menu item, keyboard shortcut,
 * MCP-declared tool, or App-Skill verifier action. Storing them as rows
 * (rather than a JSON blob on `app_profiles`) lets the Planner do
 * targeted lookups by name / kind / source without parsing the whole
 * profile every time.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { appProfiles } from "./app-profiles";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const appCapabilityCommands = sqliteTable(
  "app_capability_commands",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    appProfileId: text("app_profile_id").notNull().references(() => appProfiles.id),
    /** "command" | "menu" | "shortcut" | "mcp_tool" | "skill_action". */
    kind: text("kind").notNull(),
    /** "os_native" | "mcp" | "docs" | "skill". */
    source: text("source").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** e.g. "⌘E" or "Ctrl+Shift+P" — null if no shortcut declared. */
    shortcut: text("shortcut"),
    /** JSON-encoded extras (parameters, MCP input schema, verifier hints). */
    payloadJson: text("payload_json"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_app_cmd_tenant").on(t.tenantId),
    workspaceIdx: index("idx_app_cmd_workspace").on(t.workspaceId),
    profileIdx: index("idx_app_cmd_profile").on(t.appProfileId),
    kindIdx: index("idx_app_cmd_kind").on(t.appProfileId, t.kind),
    nameIdx: index("idx_app_cmd_name").on(t.tenantId, t.name),
  }),
);

export type AppCapabilityCommand = typeof appCapabilityCommands.$inferSelect;
export type NewAppCapabilityCommand = typeof appCapabilityCommands.$inferInsert;
