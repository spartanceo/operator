/**
 * Migration 0026 — Desktop App Auto-Update System (Task #48).
 *
 * Tables:
 *   - update_releases          catalog of published release manifests
 *                              (per channel/platform/arch). Stores both
 *                              the full installer URL+hash and an optional
 *                              delta-from-version URL+hash. Includes the
 *                              detached signature over the package digest
 *                              and the staged-rollout percentage so a bad
 *                              release can be pulled to <100% without a
 *                              redeploy. Lives under SYSTEM tenant — the
 *                              release catalogue is global, not per-user.
 *   - update_install_attempts  per-tenant log of every install the desktop
 *                              shell attempts. Powers the post-update
 *                              crash detector: if the shell records a
 *                              `launch_pending` row and the next launch
 *                              never flips it to `launch_succeeded`, the
 *                              rollback service treats the update as bad
 *                              and surfaces the previous good version.
 *   - update_pinning           per-tenant version pin (enterprise admin
 *                              freezes the fleet on a specific version)
 *                              and auto-update opt-out flag.
 *
 * All three tables follow Standard 6 (id, tenant_id, created_at,
 * updated_at, version) — `update_install_attempts` keeps `version` as well
 * because rows mutate as the install state machine progresses.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS update_releases (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    version TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'stable',
    platform TEXT NOT NULL,
    arch TEXT NOT NULL DEFAULT 'x64',
    full_url TEXT NOT NULL,
    full_sha256 TEXT NOT NULL,
    full_size INTEGER NOT NULL DEFAULT 0,
    delta_from_version TEXT,
    delta_url TEXT,
    delta_sha256 TEXT,
    delta_size INTEGER,
    signature TEXT,
    signature_algorithm TEXT NOT NULL DEFAULT 'ed25519',
    release_notes TEXT NOT NULL DEFAULT '',
    rollout_percentage INTEGER NOT NULL DEFAULT 100,
    published_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    yanked INTEGER NOT NULL DEFAULT 0,
    yanked_reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version_row INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_update_releases_channel
    ON update_releases(channel, platform, arch, published_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_update_releases_unique
    ON update_releases(channel, platform, arch, version);
  CREATE INDEX IF NOT EXISTS idx_update_releases_published
    ON update_releases(published_at);
  CREATE INDEX IF NOT EXISTS idx_update_releases_tenant
    ON update_releases(tenant_id);

  CREATE TABLE IF NOT EXISTS update_install_attempts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    device_id TEXT NOT NULL,
    from_version TEXT,
    to_version TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'stable',
    platform TEXT NOT NULL,
    arch TEXT NOT NULL DEFAULT 'x64',
    update_kind TEXT NOT NULL DEFAULT 'full',
    status TEXT NOT NULL DEFAULT 'downloading',
    failure_reason TEXT,
    signature_verified INTEGER NOT NULL DEFAULT 0,
    bytes_downloaded INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    completed_at INTEGER,
    rolled_back_at INTEGER,
    rolled_back_to_version TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_update_install_attempts_tenant
    ON update_install_attempts(tenant_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_update_install_attempts_device
    ON update_install_attempts(tenant_id, device_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_update_install_attempts_status
    ON update_install_attempts(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_update_install_attempts_workspace
    ON update_install_attempts(workspace_id);

  CREATE TABLE IF NOT EXISTS update_pinning (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    pinned_version TEXT,
    pinned_channel TEXT,
    auto_update_enabled INTEGER NOT NULL DEFAULT 1,
    managed_by TEXT NOT NULL DEFAULT 'user',
    managed_by_user_id TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_update_pinning_tenant_unique
    ON update_pinning(tenant_id);
`;

const down = `
  DROP TABLE IF EXISTS update_pinning;
  DROP TABLE IF EXISTS update_install_attempts;
  DROP TABLE IF EXISTS update_releases;
`;

export const migration: SchemaMigration = {
  id: 32,
  name: "desktop_updates",
  up,
  down,
};
