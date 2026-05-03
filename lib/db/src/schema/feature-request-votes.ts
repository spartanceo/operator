/**
 * `feature_request_votes` — append-only one-row-per-voter record on a
 * feature request.
 *
 * The vote IS the subscription — anyone who upvoted is notified when
 * the request's status changes. Append-only (no `version`); the "vote"
 * keyword in the name matches the tier-review carve-out.
 *
 * Uniqueness is on `(feature_request_id, voter_email)` so a returning
 * voter can't double-count, but they can withdraw by deleting the row
 * (handled by the service layer).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { featureRequests } from "./feature-requests";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const featureRequestVotes = sqliteTable(
  "feature_request_votes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    featureRequestId: text("feature_request_id")
      .notNull()
      .references(() => featureRequests.id),
    voterEmail: text("voter_email").notNull(),
    voterLabel: text("voter_label").notNull().default(""),
    /** 1 if the voter wants email notifications when status changes. */
    notifyOnChange: integer("notify_on_change").notNull().default(1),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_feature_request_votes_tenant").on(t.tenantId),
    workspaceIdx: index("idx_feature_request_votes_workspace").on(t.workspaceId),
    requestIdx: index("idx_feature_request_votes_request").on(t.featureRequestId),
    uniqueVoter: uniqueIndex("uq_feature_request_votes_voter").on(
      t.featureRequestId,
      t.voterEmail,
    ),
  }),
);

export type FeatureRequestVote = typeof featureRequestVotes.$inferSelect;
export type NewFeatureRequestVote = typeof featureRequestVotes.$inferInsert;
