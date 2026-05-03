/**
 * `dr_snapshots` — daily backup snapshots exported to geographically
 * isolated cold storage (Task #59 — Platform Disaster Recovery).
 *
 * Append-only history. Each row records:
 *   - the snapshot file location (cold storage URI),
 *   - the sha256 checksum of the snapshot bytes,
 *   - the integrity verification verdict (`pending → verified | failed`)
 *     written by the post-backup restore-test job,
 *   - PITR transaction-log retention pointer for that day so restores can
 *     pick a precise wall-clock minute within the 30-day window.
 *
 * The verifier records `verifyFailureReason` on failure so an on-call
 * engineer can triage without re-running the verification.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const drSnapshots = sqliteTable(
  "dr_snapshots",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    snapshotKey: text("snapshot_key").notNull(),
    coldStorageUri: text("cold_storage_uri").notNull(),
    coldStorageProvider: text("cold_storage_provider").notNull().default("offsite"),
    region: text("region").notNull().default("eu-west"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    checksum: text("checksum"),
    pitrLogStartAt: integer("pitr_log_start_at"),
    pitrLogEndAt: integer("pitr_log_end_at"),
    verifyStatus: text("verify_status").notNull().default("pending"),
    verifyAt: integer("verify_at"),
    verifyFailureReason: text("verify_failure_reason"),
    rowCount: integer("row_count").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dr_snapshots_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dr_snapshots_workspace").on(t.workspaceId),
    keyIdx: index("idx_dr_snapshots_key").on(t.tenantId, t.snapshotKey),
    createdIdx: index("idx_dr_snapshots_created").on(t.tenantId, t.createdAt),
  }),
);

export type DrSnapshot = typeof drSnapshots.$inferSelect;
export type NewDrSnapshot = typeof drSnapshots.$inferInsert;
