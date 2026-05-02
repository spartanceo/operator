/**
 * `paired_devices` — phones / tablets paired with the desktop OP via the
 * Mobile Companion PWA pairing flow.
 *
 * Each row represents one device that has successfully completed the QR
 * pairing handshake. Per-device revocation is achieved by flipping
 * `status` to `"revoked"` — the row is retained for audit history.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const pairedDevices = sqliteTable(
  "paired_devices",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Human-friendly label, e.g. "Sam's iPhone". */
    label: text("label").notNull(),
    /** "ios" | "android" | "web" — best-effort UA classification. */
    platform: text("platform").notNull().default("web"),
    userAgent: text("user_agent"),
    /** Hash of the long-lived relay token issued at pairing time. */
    tokenHash: text("token_hash").notNull(),
    /** "active" | "revoked". */
    status: text("status").notNull().default("active"),
    pairedAt: integer("paired_at").notNull().default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer("last_seen_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_paired_devices_tenant").on(t.tenantId),
    workspaceIdx: index("idx_paired_devices_workspace").on(t.workspaceId),
    statusIdx: index("idx_paired_devices_status").on(t.tenantId, t.status),
    tokenIdx: index("idx_paired_devices_token").on(t.tokenHash),
  }),
);

export type PairedDevice = typeof pairedDevices.$inferSelect;
export type NewPairedDevice = typeof pairedDevices.$inferInsert;
