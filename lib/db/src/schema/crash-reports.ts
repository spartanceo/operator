/**
 * `crash_reports` — append-only crash report submissions, gated by the
 * `optInCrashes` flag on `telemetry_settings`.
 *
 * Each report is generated locally on an unexpected app exit and shown to
 * the user for review BEFORE it is submitted. The user can redact or skip
 * the submission entirely — the privacy enforcement layer in
 * `telemetry.service.ts` strips file paths, user content, and credentials
 * from `stackTrace` and `breadcrumbs` regardless of what the client sends.
 *
 * "report" is NOT in the tier-review version-exempt keyword list, so a
 * `version` column is included even though writes are append-only. The
 * column always reads `1` and is never bumped.
 *
 * Required columns (Standard 13 / Check #5):
 *   id, tenantId, createdAt, updatedAt, version
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const crashReports = sqliteTable(
  "crash_reports",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    anonymousId: text("anonymous_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    message: text("message").notNull(),
    stackTrace: text("stack_trace"),
    breadcrumbs: text("breadcrumbs"),
    opVersion: text("op_version").notNull().default("0.1.0"),
    osPlatform: text("os_platform"),
    osVersion: text("os_version"),
    hardwareTier: text("hardware_tier"),
    submittedAt: integer("submitted_at"),
    githubIssueUrl: text("github_issue_url"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_crash_reports_tenant").on(t.tenantId),
    workspaceIdx: index("idx_crash_reports_workspace").on(t.workspaceId),
    fingerprintIdx: index("idx_crash_reports_fingerprint").on(t.tenantId, t.fingerprint),
    createdIdx: index("idx_crash_reports_created").on(t.tenantId, t.createdAt),
  }),
);

export type CrashReportRow = typeof crashReports.$inferSelect;
export type NewCrashReportRow = typeof crashReports.$inferInsert;
