/**
 * `share_events` — append-only log of every share action a user took.
 *
 * Captures `targetKind` (skill | task | creator) + `targetId` + `channel`
 * (twitter, linkedin, whatsapp, copy, native). Append-only, no `version`
 * column — same audit-class carve-out as `activity_events`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const shareEvents = sqliteTable(
  "share_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    channel: text("channel").notNull().default("copy"),
    label: text("label"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_share_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_share_events_workspace").on(t.workspaceId),
    targetIdx: index("idx_share_events_target").on(t.tenantId, t.targetKind, t.targetId),
    createdIdx: index("idx_share_events_created").on(t.tenantId, t.createdAt),
  }),
);

export type ShareEvent = typeof shareEvents.$inferSelect;
export type NewShareEvent = typeof shareEvents.$inferInsert;
