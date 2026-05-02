/**
 * `media_assets` — locally generated media (images, audio, video).
 *
 * Each row owns a binary file on disk inside the workspace sandbox at
 * `media/<id>.<ext>`. The DB row is the index; the file is the payload.
 * Deletes remove both. Tier 1 generators write deterministic stubs (SVG
 * for images, WAV for audio, animated SVG for video) so the asset library,
 * inline previews, and tool integration can be built end-to-end before the
 * heavy ML model integration ships in the desktop runtime.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("ready"),
    prompt: text("prompt").notNull(),
    style: text("style"),
    filePath: text("file_path"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    modelUsed: text("model_used").notNull().default("stub-v1"),
    sourceAssetId: text("source_asset_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_media_assets_tenant").on(t.tenantId),
    workspaceIdx: index("idx_media_assets_workspace").on(t.workspaceId),
    kindIdx: index("idx_media_assets_kind").on(t.tenantId, t.kind),
    sourceIdx: index("idx_media_assets_source").on(t.sourceAssetId),
  }),
);

export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type NewMediaAssetRow = typeof mediaAssets.$inferInsert;
