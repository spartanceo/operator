/**
 * `skill_ratings` and the moderation tables that hang off it.
 *
 * One row per (tenantId, skillId, userId) — the unique index gives us
 * the "no double-rating" guarantee. `verified_purchase` records whether
 * the rater had at least one `skill_usage_events` row when they submitted
 * (the verified-usage gate from Task #33). `status` is the moderation
 * state: `active` (visible), `hidden` (admin hid it pending appeal),
 * `removed` (deleted by admin). `helpful_count` / `unhelpful_count` are
 * cached aggregates of `skill_review_helpful_votes` so the review list
 * can sort by helpfulness without a join.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { skills } from "./skills";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillUsageEvents = sqliteTable(
  "skill_usage_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    skillId: text("skill_id").notNull().references(() => skills.id),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_skill_usage_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_usage_workspace").on(t.workspaceId),
    skillIdx: index("idx_skill_usage_skill").on(t.tenantId, t.skillId),
    userIdx: index("idx_skill_usage_user").on(
      t.tenantId,
      t.skillId,
      t.userId,
    ),
    recentIdx: index("idx_skill_usage_recent").on(t.tenantId, t.createdAt),
  }),
);

export type SkillUsageEvent = typeof skillUsageEvents.$inferSelect;
export type NewSkillUsageEvent = typeof skillUsageEvents.$inferInsert;

export const skillRatings = sqliteTable(
  "skill_ratings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    skillId: text("skill_id").notNull().references(() => skills.id),
    userId: text("user_id").notNull(),
    stars: integer("stars").notNull(),
    reviewText: text("review_text"),
    status: text("status").notNull().default("active"),
    helpfulCount: integer("helpful_count").notNull().default(0),
    unhelpfulCount: integer("unhelpful_count").notNull().default(0),
    flagCount: integer("flag_count").notNull().default(0),
    verifiedPurchase: integer("verified_purchase", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_ratings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_ratings_workspace").on(t.workspaceId),
    skillIdx: index("idx_skill_ratings_skill").on(t.tenantId, t.skillId),
    statusIdx: index("idx_skill_ratings_status").on(t.tenantId, t.status),
    helpfulIdx: index("idx_skill_ratings_helpful").on(
      t.tenantId,
      t.skillId,
      t.helpfulCount,
    ),
    createdIdx: index("idx_skill_ratings_created").on(
      t.tenantId,
      t.skillId,
      t.createdAt,
    ),
    uniquePerUser: uniqueIndex("uq_skill_ratings_user").on(
      t.tenantId,
      t.skillId,
      t.userId,
    ),
  }),
);

export type SkillRating = typeof skillRatings.$inferSelect;
export type NewSkillRating = typeof skillRatings.$inferInsert;

export const skillReviewHelpfulVotes = sqliteTable(
  "skill_review_helpful_votes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    ratingId: text("rating_id").notNull().references(() => skillRatings.id),
    userId: text("user_id").notNull(),
    helpful: integer("helpful").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_helpful_tenant").on(t.tenantId),
    workspaceIdx: index("idx_helpful_workspace").on(t.workspaceId),
    ratingIdx: index("idx_helpful_rating").on(t.tenantId, t.ratingId),
    uniquePerUser: uniqueIndex("uq_helpful_vote").on(
      t.tenantId,
      t.ratingId,
      t.userId,
    ),
  }),
);

export type SkillReviewHelpfulVote =
  typeof skillReviewHelpfulVotes.$inferSelect;
export type NewSkillReviewHelpfulVote =
  typeof skillReviewHelpfulVotes.$inferInsert;

export const skillReviewResponses = sqliteTable(
  "skill_review_responses",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    ratingId: text("rating_id").notNull().references(() => skillRatings.id),
    skillId: text("skill_id").notNull().references(() => skills.id),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_review_responses_tenant").on(t.tenantId),
    workspaceIdx: index("idx_review_responses_workspace").on(t.workspaceId),
    skillIdx: index("idx_review_responses_skill").on(t.tenantId, t.skillId),
    uniquePerRating: uniqueIndex("uq_review_response").on(
      t.tenantId,
      t.ratingId,
    ),
  }),
);

export type SkillReviewResponse = typeof skillReviewResponses.$inferSelect;
export type NewSkillReviewResponse = typeof skillReviewResponses.$inferInsert;

export const skillReviewFlags = sqliteTable(
  "skill_review_flags",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    ratingId: text("rating_id").notNull().references(() => skillRatings.id),
    skillId: text("skill_id").notNull().references(() => skills.id),
    reporterId: text("reporter_id").notNull(),
    reason: text("reason").notNull(),
    detail: text("detail"),
    status: text("status").notNull().default("open"),
    resolution: text("resolution"),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_review_flags_tenant").on(t.tenantId),
    workspaceIdx: index("idx_review_flags_workspace").on(t.workspaceId),
    statusIdx: index("idx_review_flags_status").on(t.tenantId, t.status),
    ratingIdx: index("idx_review_flags_rating").on(t.tenantId, t.ratingId),
    skillIdx: index("idx_review_flags_skill").on(t.tenantId, t.skillId),
  }),
);

export type SkillReviewFlag = typeof skillReviewFlags.$inferSelect;
export type NewSkillReviewFlag = typeof skillReviewFlags.$inferInsert;
