/**
 * `telemetry_consent` — singleton-per-tenant opt-in toggle.
 *
 * All telemetry is OFF by default (Standard 12, Section 13). A row exists
 * only when the user has made an explicit choice; the absence of a row is
 * treated as "no consent — do not send".
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const telemetryConsent = sqliteTable(
  "telemetry_consent",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    crashReportsEnabled: integer("crash_reports_enabled").notNull().default(0),
    usageMetricsEnabled: integer("usage_metrics_enabled").notNull().default(0),
    productImprovementEnabled: integer("product_improvement_enabled").notNull().default(0),
    consentGivenAt: integer("consent_given_at"),
    consentRevokedAt: integer("consent_revoked_at"),
    consentVersion: text("consent_version").notNull().default("v1"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_telemetry_consent_tenant").on(t.tenantId),
    uniqTenant: uniqueIndex("idx_telemetry_consent_unique_tenant").on(t.tenantId),
  }),
);

export type TelemetryConsent = typeof telemetryConsent.$inferSelect;
export type NewTelemetryConsent = typeof telemetryConsent.$inferInsert;
