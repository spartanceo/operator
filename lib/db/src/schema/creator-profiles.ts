/**
 * `creator_profiles` — singleton-per-tenant public creator profile.
 *
 * Backs `omninity.app/creators/<slug>` shareable portfolio pages and the
 * "Built with Omninity" embeddable badge. Slug is unique across all
 * tenants (enforced by a unique index) so URLs are stable.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const creatorProfiles = sqliteTable(
  "creator_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    handle: text("handle"),
    bio: text("bio").notNull().default(""),
    websiteUrl: text("website_url"),
    twitterUrl: text("twitter_url"),
    githubUrl: text("github_url"),
    avatarUrl: text("avatar_url"),
    badgeEnabled: integer("badge_enabled").notNull().default(1),
    published: integer("published").notNull().default(1),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_creator_profiles_tenant").on(t.tenantId),
    slugIdx: uniqueIndex("idx_creator_profiles_slug").on(t.slug),
    publishedIdx: index("idx_creator_profiles_published").on(t.published),
  }),
);

export type CreatorProfile = typeof creatorProfiles.$inferSelect;
export type NewCreatorProfile = typeof creatorProfiles.$inferInsert;
