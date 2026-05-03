/**
 * `feature_requests` — community-submitted feature requests powering the
 * public roadmap board (Task #34).
 *
 * Mutable record (status moves through the OP team workflow) so `version`
 * is required for optimistic concurrency.
 *
 * `upvoteCount` is a denormalised counter maintained alongside the
 * append-only `feature_request_votes` table — the votes table is the
 * source of truth, the counter is for cheap list rendering.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const featureRequests = sqliteTable(
  "feature_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Stable URL slug used by the public board. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** general | desktop | mobile | marketplace | model | integrations | other */
    category: text("category").notNull().default("general"),
    /** under_review | under_consideration | planned | shipped | wont_build */
    status: text("status").notNull().default("under_review"),
    /** OP team note shown publicly when status changes (e.g. shipped in v1.4). */
    statusNote: text("status_note").notNull().default(""),
    submitterLabel: text("submitter_label").notNull().default(""),
    submitterEmail: text("submitter_email").notNull().default(""),
    upvoteCount: integer("upvote_count").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_feature_requests_tenant").on(t.tenantId),
    workspaceIdx: index("idx_feature_requests_workspace").on(t.workspaceId),
    statusIdx: index("idx_feature_requests_status").on(t.status),
    upvoteIdx: index("idx_feature_requests_upvotes").on(t.upvoteCount),
    slugUnique: uniqueIndex("uq_feature_requests_slug").on(t.slug),
  }),
);

export type FeatureRequest = typeof featureRequests.$inferSelect;
export type NewFeatureRequest = typeof featureRequests.$inferInsert;
