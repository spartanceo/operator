/**
 * `mdm_fleet_devices` — fleet status beacons (Task #56).
 *
 * Every managed OP install POSTs a lightweight beacon at startup and on
 * a 4-hour interval thereafter. The Enterprise Admin portal joins this
 * table to render fleet-wide deployment health: how many machines are
 * running, which version each one is on, and how recently they were
 * active.
 *
 * One row per (tenant, machine_id). The machine id is derived by the
 * desktop shell from a stable hardware fingerprint hash so reinstalls
 * do not double-count the same physical device.
 *
 * No PII is stored — only the org-supplied hostname (often a Jamf /
 * Intune asset tag) plus version, OS, and timestamps.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const mdmFleetDevices = sqliteTable(
  "mdm_fleet_devices",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    /** Stable hardware-derived identifier; opaque to the server. */
    machineId: text("machine_id").notNull(),
    /** Asset tag / hostname surfaced in the fleet table (org-supplied). */
    hostname: text("hostname"),
    platform: text("platform").notNull().default("unknown"),
    osVersion: text("os_version"),
    appVersion: text("app_version").notNull(),
    channel: text("channel").notNull().default("stable"),
    /** Profile schema version actually applied on the device. */
    profileVersion: integer("profile_version").notNull().default(0),
    enrolledAt: integer("enrolled_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer("last_seen_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_mdm_fleet_devices_tenant").on(t.tenantId),
    machineIdx: index("idx_mdm_fleet_devices_machine").on(
      t.tenantId,
      t.machineId,
    ),
    uniqMachine: uniqueIndex("uniq_mdm_fleet_devices_machine").on(
      t.tenantId,
      t.machineId,
    ),
  }),
);

export type MdmFleetDevice = typeof mdmFleetDevices.$inferSelect;
export type NewMdmFleetDevice = typeof mdmFleetDevices.$inferInsert;
