/**
 * Migration 0005 — media_assets.
 *
 * Index for locally generated media (image / audio / video). The DB row is
 * the index; the actual binary lives on disk inside the workspace sandbox
 * at `media/<id>.<ext>`. Tier-1 generators write deterministic stubs (SVG
 * for images, WAV for audio, animated SVG for video) so the asset library,
 * inline previews, and tool integration can be built end-to-end before the
 * heavy ML model integration ships in the desktop runtime.
 *
 * Added during the Task #10 rebase rather than back-patched into baseline
 * so already-migrated databases pick this up cleanly without checksum drift.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    prompt TEXT NOT NULL,
    style TEXT,
    file_path TEXT,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    model_used TEXT NOT NULL DEFAULT 'stub-v1',
    source_asset_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_media_assets_tenant ON media_assets(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_media_assets_workspace ON media_assets(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_media_assets_kind ON media_assets(tenant_id, kind);
  CREATE INDEX IF NOT EXISTS idx_media_assets_source ON media_assets(source_asset_id);
`;

const down = `
  DROP TABLE IF EXISTS media_assets;
`;

export const migration: SchemaMigration = {
  id: 7,
  name: "media_assets",
  up,
  down,
};
