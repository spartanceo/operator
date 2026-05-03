/**
 * `update_releases` — published release manifest catalogue (Task #48).
 *
 * One row per (channel, platform, arch, version). Holds the URL + SHA-256
 * + size for both the full installer and an optional delta-from-version
 * package, plus the detached signature over the package digest and the
 * staged-rollout percentage. Yanked releases stay in the table for
 * audit but are never returned to clients.
 *
 * Stored under SYSTEM tenant — release manifests are global, not per-user.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const updateReleases = sqliteTable(
  "update_releases",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    version: text("version").notNull(),
    channel: text("channel").notNull().default("stable"),
    platform: text("platform").notNull(),
    arch: text("arch").notNull().default("x64"),
    fullUrl: text("full_url").notNull(),
    fullSha256: text("full_sha256").notNull(),
    fullSize: integer("full_size").notNull().default(0),
    deltaFromVersion: text("delta_from_version"),
    deltaUrl: text("delta_url"),
    deltaSha256: text("delta_sha256"),
    deltaSize: integer("delta_size"),
    signature: text("signature"),
    signatureAlgorithm: text("signature_algorithm").notNull().default("ed25519"),
    releaseNotes: text("release_notes").notNull().default(""),
    rolloutPercentage: integer("rollout_percentage").notNull().default(100),
    publishedAt: integer("published_at").notNull().default(sql`(unixepoch() * 1000)`),
    yanked: integer("yanked").notNull().default(0),
    yankedReason: text("yanked_reason"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    versionRow: integer("version_row").notNull().default(1),
  },
  (t) => ({
    channelIdx: index("idx_update_releases_channel").on(
      t.channel,
      t.platform,
      t.arch,
      t.publishedAt,
    ),
    uniqueIdx: uniqueIndex("idx_update_releases_unique").on(
      t.channel,
      t.platform,
      t.arch,
      t.version,
    ),
    publishedIdx: index("idx_update_releases_published").on(t.publishedAt),
    tenantIdx: index("idx_update_releases_tenant").on(t.tenantId),
  }),
);

export type UpdateRelease = typeof updateReleases.$inferSelect;
export type NewUpdateRelease = typeof updateReleases.$inferInsert;
