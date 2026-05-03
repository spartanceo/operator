/**
 * `skill_moderation_*` — tables backing the Skill Content Moderation &
 * Safety Pipeline (Task #57).
 *
 * Three tables:
 *  - `skillModerationSubmissions` — one row per skill submission. Holds
 *    the static / dynamic / manifest / dependency analysis reports
 *    (JSON-encoded), the computed risk score, status, reviewer notes,
 *    priority tier, and SLA deadline.
 *  - `skillModerationAppeals` — one row per creator appeal of a rejection.
 *  - `skillModerationRescans` — append-only post-publish re-scan log
 *    (dependency CVE rescan, anomaly detection, user-report suspension,
 *    emergency suspension).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillModerationSubmissions = sqliteTable(
  "skill_moderation_submissions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Originating skill_drafts row (nullable for store re-scan submissions). */
    draftId: text("draft_id"),
    /** Linked store_skills row once published. */
    storeSkillId: text("store_skill_id"),
    creatorId: text("creator_id"),
    creatorHandle: text("creator_handle").notNull().default(""),
    slug: text("slug").notNull().default(""),
    name: text("name").notNull().default(""),
    /** Skill source code submitted for analysis. */
    source: text("source").notNull().default(""),
    /** JSON-encoded skill manifest (declared permissions / network hosts / etc.). */
    manifestJson: text("manifest_json").notNull().default("{}"),
    /** JSON-encoded `StaticAnalysisReport`. */
    staticReport: text("static_report").notNull().default("{}"),
    /** JSON-encoded `DynamicAnalysisReport`. */
    dynamicReport: text("dynamic_report").notNull().default("{}"),
    /** JSON-encoded `ManifestValidationReport`. */
    manifestReport: text("manifest_report").notNull().default("{}"),
    /** JSON-encoded `DependencyAuditReport`. */
    dependencyReport: text("dependency_report").notNull().default("{}"),
    /** Composite risk score 0..100 (higher = riskier). */
    riskScore: integer("risk_score").notNull().default(0),
    /**
     * pending | static_running | static_failed | dynamic_running |
     * dynamic_failed | awaiting_review | approved | rejected | suspended.
     */
    status: text("status").notNull().default("pending"),
    /** "" | auto_approved | auto_rejected | queued_for_review */
    autoDecision: text("auto_decision").notNull().default(""),
    /** "standard" | "verified" — verified creators get the 24h queue. */
    priority: text("priority").notNull().default("standard"),
    slaDeadline: integer("sla_deadline"),
    reviewer: text("reviewer").notNull().default(""),
    reviewerNotes: text("reviewer_notes").notNull().default(""),
    rejectionReason: text("rejection_reason").notNull().default(""),
    submittedAt: integer("submitted_at").notNull().default(sql`(unixepoch() * 1000)`),
    staticCompletedAt: integer("static_completed_at"),
    dynamicCompletedAt: integer("dynamic_completed_at"),
    reviewedAt: integer("reviewed_at"),
    suspendedAt: integer("suspended_at"),
    suspensionReason: text("suspension_reason").notNull().default(""),
    /** How many times this slug has been rejected — three triggers a 30-day ban. */
    rejectionCount: integer("rejection_count").notNull().default(0),
    submissionBanUntil: integer("submission_ban_until"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_moderation_submissions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_moderation_submissions_workspace").on(t.workspaceId),
    statusIdx: index("idx_skill_moderation_submissions_status").on(t.status),
    priorityIdx: index("idx_skill_moderation_submissions_priority").on(
      t.priority,
      t.slaDeadline,
    ),
    creatorIdx: index("idx_skill_moderation_submissions_creator").on(t.creatorHandle),
    draftIdx: index("idx_skill_moderation_submissions_draft").on(t.draftId),
    slugIdx: index("idx_skill_moderation_submissions_slug").on(t.creatorHandle, t.slug),
  }),
);

export type SkillModerationSubmission =
  typeof skillModerationSubmissions.$inferSelect;
export type NewSkillModerationSubmission =
  typeof skillModerationSubmissions.$inferInsert;

export const skillModerationAppeals = sqliteTable(
  "skill_moderation_appeals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    submissionId: text("submission_id")
      .notNull()
      .references(() => skillModerationSubmissions.id),
    creatorId: text("creator_id"),
    creatorHandle: text("creator_handle").notNull().default(""),
    reason: text("reason").notNull(),
    /** pending | upheld | denied */
    status: text("status").notNull().default("pending"),
    seniorReviewer: text("senior_reviewer").notNull().default(""),
    decisionNotes: text("decision_notes").notNull().default(""),
    decidedAt: integer("decided_at"),
    /** Wall-clock when the 14-day appeal window closes. */
    appealDeadline: integer("appeal_deadline").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_moderation_appeals_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_moderation_appeals_workspace").on(t.workspaceId),
    submissionIdx: index("idx_skill_moderation_appeals_submission").on(t.submissionId),
    statusIdx: index("idx_skill_moderation_appeals_status").on(t.status),
  }),
);

export type SkillModerationAppeal = typeof skillModerationAppeals.$inferSelect;
export type NewSkillModerationAppeal = typeof skillModerationAppeals.$inferInsert;

/**
 * Append-only — re-scan / suspension events. The tier-review schema check
 * exempts table names containing "log" / "event" / "rescan" pattern from
 * the version-column requirement; this table omits it intentionally.
 */
export const skillModerationRescans = sqliteTable(
  "skill_moderation_rescans",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    submissionId: text("submission_id"),
    storeSkillId: text("store_skill_id"),
    creatorHandle: text("creator_handle").notNull().default(""),
    slug: text("slug").notNull().default(""),
    /** dependency_cve | user_report | anomaly | emergency | scheduled */
    trigger: text("trigger").notNull(),
    severity: text("severity").notNull().default("info"),
    finding: text("finding").notNull().default(""),
    detail: text("detail").notNull().default("{}"),
    actor: text("actor").notNull().default("system"),
    suspended: integer("suspended", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_moderation_rescans_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_moderation_rescans_workspace").on(t.workspaceId),
    storeIdx: index("idx_skill_moderation_rescans_store").on(t.storeSkillId),
    slugIdx: index("idx_skill_moderation_rescans_slug").on(t.creatorHandle, t.slug),
    createdIdx: index("idx_skill_moderation_rescans_created").on(t.createdAt),
  }),
);

export type SkillModerationRescan = typeof skillModerationRescans.$inferSelect;
export type NewSkillModerationRescan = typeof skillModerationRescans.$inferInsert;
