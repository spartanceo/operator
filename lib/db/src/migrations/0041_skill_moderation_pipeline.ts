/**
 * Migration 0039 — Skill Moderation & Safety Pipeline (Task #57).
 *
 * Adds the persistent state for the end-to-end skill submission pipeline:
 *
 *   - `skill_moderation_submissions` — one row per skill submission. Holds
 *     the static-analysis report, dynamic-analysis report, manifest report,
 *     dependency report, computed risk score, status, reviewer notes,
 *     priority queue tier, and SLA deadline. Mutable — has a `version`
 *     column for optimistic concurrency.
 *
 *   - `skill_moderation_appeals` — one row per creator appeal of a
 *     rejection. Status walks `pending → upheld | denied`. Senior reviewer
 *     and decision are captured for the audit trail.
 *
 *   - `skill_moderation_rescans` — append-only log of post-publish
 *     re-scans (dependency CVE rescan, anomaly detection, user-report
 *     suspension, emergency suspension). Used by the Super Admin portal
 *     to surface "why was this skill suspended".
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS skill_moderation_submissions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    draft_id TEXT,
    store_skill_id TEXT,
    creator_id TEXT,
    creator_handle TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    manifest_json TEXT NOT NULL DEFAULT '{}',
    static_report TEXT NOT NULL DEFAULT '{}',
    dynamic_report TEXT NOT NULL DEFAULT '{}',
    manifest_report TEXT NOT NULL DEFAULT '{}',
    dependency_report TEXT NOT NULL DEFAULT '{}',
    risk_score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    auto_decision TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'standard',
    sla_deadline INTEGER,
    reviewer TEXT NOT NULL DEFAULT '',
    reviewer_notes TEXT NOT NULL DEFAULT '',
    rejection_reason TEXT NOT NULL DEFAULT '',
    submitted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    static_completed_at INTEGER,
    dynamic_completed_at INTEGER,
    reviewed_at INTEGER,
    suspended_at INTEGER,
    suspension_reason TEXT NOT NULL DEFAULT '',
    rejection_count INTEGER NOT NULL DEFAULT 0,
    submission_ban_until INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_submissions_tenant ON skill_moderation_submissions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_submissions_workspace ON skill_moderation_submissions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_submissions_status ON skill_moderation_submissions(status);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_submissions_priority ON skill_moderation_submissions(priority, sla_deadline);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_submissions_creator ON skill_moderation_submissions(creator_handle);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_submissions_draft ON skill_moderation_submissions(draft_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_submissions_slug ON skill_moderation_submissions(creator_handle, slug);

  CREATE TABLE IF NOT EXISTS skill_moderation_appeals (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    submission_id TEXT NOT NULL REFERENCES skill_moderation_submissions(id),
    creator_id TEXT,
    creator_handle TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    senior_reviewer TEXT NOT NULL DEFAULT '',
    decision_notes TEXT NOT NULL DEFAULT '',
    decided_at INTEGER,
    appeal_deadline INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_appeals_tenant ON skill_moderation_appeals(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_appeals_workspace ON skill_moderation_appeals(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_appeals_submission ON skill_moderation_appeals(submission_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_appeals_status ON skill_moderation_appeals(status);

  CREATE TABLE IF NOT EXISTS skill_moderation_rescans (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    submission_id TEXT,
    store_skill_id TEXT,
    creator_handle TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    finding TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '{}',
    actor TEXT NOT NULL DEFAULT 'system',
    suspended INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_rescans_tenant ON skill_moderation_rescans(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_rescans_workspace ON skill_moderation_rescans(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_rescans_store ON skill_moderation_rescans(store_skill_id);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_rescans_slug ON skill_moderation_rescans(creator_handle, slug);
  CREATE INDEX IF NOT EXISTS idx_skill_moderation_rescans_created ON skill_moderation_rescans(created_at);
`;

const down = `
  DROP TABLE IF EXISTS skill_moderation_rescans;
  DROP TABLE IF EXISTS skill_moderation_appeals;
  DROP TABLE IF EXISTS skill_moderation_submissions;
`;

export const migration: SchemaMigration = {
  id: 41,
  name: "skill_moderation_pipeline",
  up,
  down,
};
