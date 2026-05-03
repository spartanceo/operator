/**
 * Migration 0031 — Enterprise MDM & silent-deployment surface (Task #56).
 *
 * Two additive tables that back the Jamf / Intune / SCCM tooling:
 *
 *   1. `mdm_profiles` — exactly one configuration profile per tenant,
 *      pushed by IT via .mobileconfig (mac), GPO (Windows Registry), or
 *      the Enterprise Admin portal. Carries the organisation name, the
 *      JSON-encoded settings bundle, and the array of admin-locked keys
 *      the local user may not override.
 *
 *   2. `mdm_fleet_devices` — one row per managed OP install. The desktop
 *      shell beacons in at launch and every 4 hours; the Enterprise Admin
 *      portal joins this table to render fleet-wide deployment health
 *      (machine count, version distribution, last-seen ages).
 *
 * Defaults are JSON literals (`'{}'`, `'[]'`) so a back-fill is a no-op
 * and the unique indexes guarantee the per-tenant / per-machine
 * invariants without application-level checks.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS mdm_profiles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    source TEXT NOT NULL DEFAULT 'manual',
    organisation_name TEXT NOT NULL,
    profile_version INTEGER NOT NULL DEFAULT 1,
    values_json TEXT NOT NULL DEFAULT '{}',
    locked_keys_json TEXT NOT NULL DEFAULT '[]',
    last_applied_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_mdm_profiles_tenant
    ON mdm_profiles(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_mdm_profiles_tenant
    ON mdm_profiles(tenant_id);

  CREATE TABLE IF NOT EXISTS mdm_fleet_devices (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    machine_id TEXT NOT NULL,
    hostname TEXT,
    platform TEXT NOT NULL DEFAULT 'unknown',
    os_version TEXT,
    app_version TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'stable',
    profile_version INTEGER NOT NULL DEFAULT 0,
    enrolled_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_mdm_fleet_devices_tenant
    ON mdm_fleet_devices(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_mdm_fleet_devices_machine
    ON mdm_fleet_devices(tenant_id, machine_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_mdm_fleet_devices_machine
    ON mdm_fleet_devices(tenant_id, machine_id);
`;

const down = `
  DROP TABLE IF EXISTS mdm_fleet_devices;
  DROP TABLE IF EXISTS mdm_profiles;
`;

export const migration: SchemaMigration = {
  id: 35,
  name: "mdm_enterprise",
  up,
  down,
};
