/**
 * Migration 0023 — Marketplace Reviews, Ratings & Trust System (Task #33).
 *
 * Adds the rating + review tables that gate trust signals for the local
 * Skills Marketplace, plus a `skill_usage_events` audit trail used for the
 * "verified usage only" rule (a user must have run a skill at least once
 * before they can rate it).
 *
 * Also extends `skills` with the cached aggregates the browse view needs
 * to sort by Highest Rated / Most Used without a per-page join: rating
 * average, rating count, total usage count, and the editorial-curated
 * "OP Pick" / "Verified by OP" trust badge flags.
 *
 * `low_rating_alert_at` is the timestamp of the last creator notification
 * sent when a skill's average rating dropped below the threshold — used
 * to throttle the alerts so a creator does not get spammed once their
 * skill crosses the line.
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE skills ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN rating_avg REAL NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN editorial_pick INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN verified_by_op INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE skills ADD COLUMN low_rating_alert_at INTEGER;

  CREATE INDEX IF NOT EXISTS idx_skills_rating ON skills(tenant_id, rating_avg);
  CREATE INDEX IF NOT EXISTS idx_skills_usage ON skills(tenant_id, usage_count);
  CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(tenant_id, updated_at);

  CREATE TABLE IF NOT EXISTS skill_usage_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    user_id TEXT NOT NULL,
    run_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_skill_usage_tenant
    ON skill_usage_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_usage_workspace
    ON skill_usage_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_usage_skill
    ON skill_usage_events(tenant_id, skill_id);
  CREATE INDEX IF NOT EXISTS idx_skill_usage_user
    ON skill_usage_events(tenant_id, skill_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_skill_usage_recent
    ON skill_usage_events(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS skill_ratings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    user_id TEXT NOT NULL,
    stars INTEGER NOT NULL,
    review_text TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    helpful_count INTEGER NOT NULL DEFAULT 0,
    unhelpful_count INTEGER NOT NULL DEFAULT 0,
    flag_count INTEGER NOT NULL DEFAULT 0,
    verified_purchase INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(tenant_id, skill_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_skill_ratings_tenant
    ON skill_ratings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_ratings_workspace
    ON skill_ratings(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_ratings_skill
    ON skill_ratings(tenant_id, skill_id);
  CREATE INDEX IF NOT EXISTS idx_skill_ratings_status
    ON skill_ratings(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_skill_ratings_helpful
    ON skill_ratings(tenant_id, skill_id, helpful_count);
  CREATE INDEX IF NOT EXISTS idx_skill_ratings_created
    ON skill_ratings(tenant_id, skill_id, created_at);

  CREATE TABLE IF NOT EXISTS skill_review_helpful_votes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    rating_id TEXT NOT NULL REFERENCES skill_ratings(id),
    user_id TEXT NOT NULL,
    helpful INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    UNIQUE(tenant_id, rating_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_helpful_tenant
    ON skill_review_helpful_votes(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_helpful_workspace
    ON skill_review_helpful_votes(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_helpful_rating
    ON skill_review_helpful_votes(tenant_id, rating_id);

  CREATE TABLE IF NOT EXISTS skill_review_responses (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    rating_id TEXT NOT NULL REFERENCES skill_ratings(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(tenant_id, rating_id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_responses_tenant
    ON skill_review_responses(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_review_responses_workspace
    ON skill_review_responses(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_review_responses_skill
    ON skill_review_responses(tenant_id, skill_id);

  CREATE TABLE IF NOT EXISTS skill_review_flags (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    rating_id TEXT NOT NULL REFERENCES skill_ratings(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    reporter_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    resolved_at INTEGER,
    resolved_by TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_review_flags_tenant
    ON skill_review_flags(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_review_flags_workspace
    ON skill_review_flags(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_review_flags_status
    ON skill_review_flags(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_review_flags_rating
    ON skill_review_flags(tenant_id, rating_id);
`;

const down = `
  DROP TABLE IF EXISTS skill_review_flags;
  DROP TABLE IF EXISTS skill_review_responses;
  DROP TABLE IF EXISTS skill_review_helpful_votes;
  DROP TABLE IF EXISTS skill_ratings;
  DROP TABLE IF EXISTS skill_usage_events;
`;

export const migration: SchemaMigration = {
  id: 23,
  name: "skill_reviews_trust",
  up,
  down,
};
