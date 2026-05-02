/**
 * `telemetry_settings` — singleton per tenant capturing the user's opt-in
 * consent for analytics, performance metrics, and crash reports.
 *
 * Why a singleton table per tenant:
 *   The consent decision is tenant-level intent (one OP install = one
 *   tenant). Keying the row id by `tenantId` makes the upsert path
 *   branch-free — INSERT-or-UPDATE against the primary key.
 *
 * Default-OFF guarantee: every flag column defaults to `0` in SQL so a
 * missing row is functionally identical to "all opt-ins are off". Routes
 * may therefore treat "no row" as the implicit default without having to
 * insert a row on the read path.
 *
 * Required columns (Standard 13 / Check #5):
 *   id, tenantId, createdAt, updatedAt, version
 *
 * Tier-review note: Check #5 parses tables with a regex that stops at the
 * first `}` inside the column object, so option objects are intentionally
 * avoided here.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const telemetrySettings = sqliteTable(
  "telemetry_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    optInUsage: integer("opt_in_usage").notNull().default(0),
    optInPerformance: integer("opt_in_performance").notNull().default(0),
    optInCrashes: integer("opt_in_crashes").notNull().default(0),
    optInOnboarding: integer("opt_in_onboarding").notNull().default(0),
    optInMarketplace: integer("opt_in_marketplace").notNull().default(0),
    anonymousId: text("anonymous_id").notNull(),
    consentGivenAt: integer("consent_given_at"),
    consentRevokedAt: integer("consent_revoked_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_telemetry_settings_tenant").on(t.tenantId),
  }),
);

export type TelemetrySettingsRow = typeof telemetrySettings.$inferSelect;
export type NewTelemetrySettingsRow = typeof telemetrySettings.$inferInsert;
