/**
 * Migration 0025 — Referral & growth mechanics (Task #35).
 *
 * Adds the eleven tables that back the viral-growth surface area:
 *   - referral_codes              singleton-per-tenant referral identity.
 *   - referrals                   attribution rows (pending → completed).
 *   - referral_rewards            granted dual-reward records (30d access).
 *   - acquisition_channels        "how did you hear" survey answer.
 *   - share_events                append-only log of share actions.
 *   - task_satisfaction_ratings   append-only thumbs after a run finishes.
 *   - creator_profiles            singleton-per-tenant public profile.
 *   - creator_milestones          append-only "1k installs" achievements.
 *   - enterprise_trial_invites    "OP for Teams" colleague invites.
 *   - waitlist_signups            public marketing-site email capture.
 *   - beta_access_grants          singleton-per-tenant beta tier flag.
 *
 * Audit-class tables (share_events, task_satisfaction_ratings,
 * creator_milestones, waitlist_signups) deliberately omit `version` per
 * Standard 6's append-only carve-out.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS referral_codes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    code TEXT NOT NULL,
    share_url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_referral_codes_tenant ON referral_codes(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_tenant_unique ON referral_codes(tenant_id);

  CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    referrer_tenant_id TEXT NOT NULL REFERENCES tenants(id),
    referred_tenant_id TEXT REFERENCES tenants(id),
    referred_email TEXT,
    referred_label TEXT,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    completed_at INTEGER,
    reward_granted_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_tenant ON referrals(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_tenant_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_tenant_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);
  CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(tenant_id, status);

  CREATE TABLE IF NOT EXISTS referral_rewards (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    referral_id TEXT,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_referral_rewards_tenant ON referral_rewards(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_referral_rewards_expires ON referral_rewards(tenant_id, expires_at);

  CREATE TABLE IF NOT EXISTS acquisition_channels (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    channel TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_acquisition_channels_tenant ON acquisition_channels(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_acquisition_channels_channel ON acquisition_channels(channel);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_channels_tenant_unique ON acquisition_channels(tenant_id);

  CREATE TABLE IF NOT EXISTS share_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'copy',
    label TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_share_events_tenant ON share_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_share_events_workspace ON share_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_share_events_target ON share_events(tenant_id, target_kind, target_id);
  CREATE INDEX IF NOT EXISTS idx_share_events_created ON share_events(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS task_satisfaction_ratings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    run_id TEXT,
    rating TEXT NOT NULL,
    summary TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_task_satisfaction_tenant ON task_satisfaction_ratings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_task_satisfaction_workspace ON task_satisfaction_ratings(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_task_satisfaction_run ON task_satisfaction_ratings(tenant_id, run_id);
  CREATE INDEX IF NOT EXISTS idx_task_satisfaction_rating ON task_satisfaction_ratings(tenant_id, rating);

  CREATE TABLE IF NOT EXISTS creator_profiles (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    handle TEXT,
    bio TEXT NOT NULL DEFAULT '',
    website_url TEXT,
    twitter_url TEXT,
    github_url TEXT,
    avatar_url TEXT,
    badge_enabled INTEGER NOT NULL DEFAULT 1,
    published INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_creator_profiles_tenant ON creator_profiles(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_profiles_slug ON creator_profiles(slug);
  CREATE INDEX IF NOT EXISTS idx_creator_profiles_published ON creator_profiles(published);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_profiles_tenant_unique ON creator_profiles(tenant_id);

  CREATE TABLE IF NOT EXISTS creator_milestones (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    skill_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    milestone TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_creator_milestones_tenant ON creator_milestones(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_creator_milestones_skill ON creator_milestones(tenant_id, skill_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_milestones_unique
    ON creator_milestones(tenant_id, skill_id, threshold);

  CREATE TABLE IF NOT EXISTS enterprise_trial_invites (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    colleague_email TEXT NOT NULL,
    colleague_name TEXT,
    company TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_enterprise_trial_invites_tenant ON enterprise_trial_invites(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_trial_invites_status
    ON enterprise_trial_invites(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_enterprise_trial_invites_email ON enterprise_trial_invites(colleague_email);

  CREATE TABLE IF NOT EXISTS waitlist_signups (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    feature TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    source TEXT,
    referral_code TEXT,
    notified_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_waitlist_signups_tenant ON waitlist_signups(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_waitlist_signups_feature ON waitlist_signups(feature);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_signups_unique ON waitlist_signups(feature, email);

  CREATE TABLE IF NOT EXISTS beta_access_grants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    tier TEXT NOT NULL DEFAULT 'beta',
    reason TEXT NOT NULL DEFAULT 'referral_threshold',
    granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_beta_access_tenant ON beta_access_grants(tenant_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_beta_access_tenant_unique ON beta_access_grants(tenant_id);
`;

const down = `
  DROP TABLE IF EXISTS beta_access_grants;
  DROP TABLE IF EXISTS waitlist_signups;
  DROP TABLE IF EXISTS enterprise_trial_invites;
  DROP TABLE IF EXISTS creator_milestones;
  DROP TABLE IF EXISTS creator_profiles;
  DROP TABLE IF EXISTS task_satisfaction_ratings;
  DROP TABLE IF EXISTS share_events;
  DROP TABLE IF EXISTS acquisition_channels;
  DROP TABLE IF EXISTS referral_rewards;
  DROP TABLE IF EXISTS referrals;
  DROP TABLE IF EXISTS referral_codes;
`;

export const migration: SchemaMigration = {
  id: 25,
  name: "referral_growth",
  up,
  down,
};
