/**
 * `feature_feedback_events` — append-only thumbs up/down on any feature
 * surface (Task #34).
 *
 * Used by the in-app feedback button — a user taps thumbs up/down on a
 * specific feature key (`agent.run`, `desktop.click`, `marketplace`, …)
 * with an optional comment. Aggregate sentiment is computed by the OP
 * team support dashboard.
 *
 * Append-only ("event" keyword) — no `version` column.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const featureFeedbackEvents = sqliteTable(
  "feature_feedback_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Stable feature key — short dotted identifier ("chat.send"). */
    featureKey: text("feature_key").notNull(),
    /** up | down */
    sentiment: text("sentiment").notNull(),
    comment: text("comment").notNull().default(""),
    submitterLabel: text("submitter_label").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_feature_feedback_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_feature_feedback_events_workspace").on(t.workspaceId),
    featureIdx: index("idx_feature_feedback_events_feature").on(t.featureKey),
    sentimentIdx: index("idx_feature_feedback_events_sentiment").on(t.sentiment),
  }),
);

export type FeatureFeedbackEvent = typeof featureFeedbackEvents.$inferSelect;
export type NewFeatureFeedbackEvent = typeof featureFeedbackEvents.$inferInsert;
