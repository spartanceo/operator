/**
 * `model_preferences` — one row per tenant capturing the user's persistent
 * model + vision-lifecycle choices (Task #64).
 *
 * Why a dedicated table (not extra columns on `onboarding_profiles`):
 *   Onboarding answers are write-once intent ("I'm a developer working on
 *   coding tasks"); model + vision settings are *mutable* configuration
 *   the user can swap from Settings any time. Splitting the tables keeps
 *   the upsert paths simple and the bug surface small (the wizard's
 *   monotonic flags never overlap with mutable preferences).
 *
 * Required columns (Standard 13 / Check #5):
 *   id, tenantId, createdAt, updatedAt, version
 *
 * Note on column shape: tier-review check #5 parses `sqliteTable(...)` with
 * a regex that stops at the first `}` it sees inside the column object —
 * so we deliberately avoid inline `{ mode: ... }` option objects.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const modelPreferences = sqliteTable(
  "model_preferences",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    primaryModel: text("primary_model"),
    visionLifecycleMode: text("vision_lifecycle_mode"),
    visionIdleTimeoutMs: integer("vision_idle_timeout_ms"),
    catalogueChoiceMade: integer("catalogue_choice_made").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_model_preferences_tenant").on(t.tenantId),
  }),
);

export type ModelPreferenceRow = typeof modelPreferences.$inferSelect;
export type NewModelPreferenceRow = typeof modelPreferences.$inferInsert;
