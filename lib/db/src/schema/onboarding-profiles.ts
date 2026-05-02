/**
 * `onboarding_profiles` — one row per tenant capturing the answers the
 * setup wizard collected on first launch and the monotonic completion
 * flags the chat surface keys off.
 *
 * Why a singleton table per tenant:
 *   The wizard answers are owner-level intent, not workspace-scoped data.
 *   Keying by `tenantId` (which is also the row id) lets the upsert path
 *   stay branch-free — `INSERT ... ON CONFLICT DO UPDATE` against the PK.
 *
 * Required columns (Standard 13 / Check #5):
 *   id, tenantId, createdAt, updatedAt, version
 *
 * Note on column shape: the tier-review check #5 parses the table call
 * with a regex that stops at the first `}` it sees inside the column
 * object — so column option objects are deliberately AVOIDED and JSON
 * blobs (hardware snapshot) are stored as plain `text` columns.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const onboardingProfiles = sqliteTable(
  "onboarding_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    displayName: text("display_name"),
    userType: text("user_type"),
    useCase: text("use_case"),
    recommendedModel: text("recommended_model"),
    completed: integer("completed").notNull().default(0),
    firstTaskCompleted: integer("first_task_completed").notNull().default(0),
    approvalTooltipSeen: integer("approval_tooltip_seen").notNull().default(0),
    hardwareSnapshot: text("hardware_snapshot"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_onboarding_profiles_tenant").on(t.tenantId),
    completedIdx: index("idx_onboarding_profiles_completed").on(
      t.tenantId,
      t.completed,
    ),
  }),
);

export type OnboardingProfile = typeof onboardingProfiles.$inferSelect;
export type NewOnboardingProfile = typeof onboardingProfiles.$inferInsert;
