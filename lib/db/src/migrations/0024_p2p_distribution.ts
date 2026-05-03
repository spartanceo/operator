/**
 * Migration 0024 — P2P Model & Skill Distribution Network (Task #13).
 *
 * Persists the durable bits of the P2P control plane so a server
 * restart does not vaporise the catalogue or per-tenant seeding
 * preferences:
 *
 *   - p2p_publisher_keys   — pinned Ed25519 publisher key registry,
 *                            populated from `OMNINITY_P2P_PINNED_KEYS`
 *                            at boot. The HTTP surface is read-only.
 *   - p2p_content_manifests — signed content manifests (model + skill
 *                            releases). Signature verification happens
 *                            in the service before insert.
 *   - p2p_seeding_settings  — per-tenant seeding/relay/fallback toggles.
 *
 * Per-tenant swarm telemetry (peer counts, bytes transferred) stays in
 * memory — it is ephemeral status that the desktop shell re-announces
 * on its next heartbeat.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS p2p_publisher_keys (
    key_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    registered_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_p2p_publisher_keys_pinned
    ON p2p_publisher_keys(pinned);

  CREATE TABLE IF NOT EXISTS p2p_content_manifests (
    content_id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL,
    version_label TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    magnet_uri TEXT NOT NULL,
    ipfs_cid TEXT NOT NULL,
    fallback_url TEXT,
    publisher_key_id TEXT NOT NULL REFERENCES p2p_publisher_keys(key_id),
    published_at TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_p2p_content_type
    ON p2p_content_manifests(content_type);
  CREATE INDEX IF NOT EXISTS idx_p2p_content_publisher
    ON p2p_content_manifests(publisher_key_id);

  CREATE TABLE IF NOT EXISTS p2p_seeding_settings (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
    seeding_enabled INTEGER NOT NULL DEFAULT 1,
    upload_cap_mbps REAL,
    use_relay INTEGER NOT NULL DEFAULT 1,
    fallback_to_cdn INTEGER NOT NULL DEFAULT 1,
    peer_floor INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
`;

const down = `
  DROP TABLE IF EXISTS p2p_seeding_settings;
  DROP TABLE IF EXISTS p2p_content_manifests;
  DROP TABLE IF EXISTS p2p_publisher_keys;
`;

export const migration: SchemaMigration = {
  id: 24,
  name: "p2p_distribution",
  up,
  down,
};
