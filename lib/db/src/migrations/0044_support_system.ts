/**
 * Migration 0044 — Customer Support & User Feedback System (Task #34).
 *
 * Creates the eight tables backing the in-app support panel, ticket
 * system, feature request board, in-app status page, and OP team
 * support dashboard:
 *
 *   - support_tickets             user-submitted tickets (mutable).
 *   - support_ticket_events       append-only conversation log on a ticket.
 *   - support_response_templates  canned reply snippets used by OP team.
 *   - feature_requests            community-submitted requests (mutable).
 *   - feature_request_votes       append-only upvotes / subscriptions.
 *   - feature_feedback_events     append-only thumbs up/down on features.
 *   - service_status_components   per-component health for the status page.
 *   - service_status_incidents    published incident timeline entries.
 *
 * Every table follows the standard tenant_id / workspace_id / created_at /
 * updated_at / version contract enforced by the tier-review schema gate.
 * Append-only audit-class tables (`*_events`, `*_votes`) deliberately
 * omit `version` per Standard 6's append-only carve-out.
 *
 * A small set of system-tenant rows are seeded for the four core status
 * components (marketplace, sync, payments, update-server) so the
 * in-app status page renders without operator action.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_email TEXT NOT NULL,
    user_label TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'open',
    op_version TEXT NOT NULL DEFAULT '',
    os_info TEXT NOT NULL DEFAULT '',
    hardware_tier TEXT NOT NULL DEFAULT '',
    attachment_note TEXT NOT NULL DEFAULT '',
    escalated INTEGER NOT NULL DEFAULT 0,
    assignee_label TEXT NOT NULL DEFAULT '',
    resolution_notes TEXT NOT NULL DEFAULT '',
    resolved_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_workspace ON support_tickets(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at);

  CREATE TABLE IF NOT EXISTS support_ticket_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
    sender TEXT NOT NULL DEFAULT 'user',
    sender_label TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_support_ticket_events_tenant ON support_ticket_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_support_ticket_events_workspace ON support_ticket_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket ON support_ticket_events(ticket_id);

  CREATE TABLE IF NOT EXISTS support_response_templates (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    label TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_support_response_templates_tenant ON support_response_templates(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_support_response_templates_workspace ON support_response_templates(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_support_response_templates_category ON support_response_templates(category);

  CREATE TABLE IF NOT EXISTS feature_requests (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    status TEXT NOT NULL DEFAULT 'under_review',
    status_note TEXT NOT NULL DEFAULT '',
    submitter_label TEXT NOT NULL DEFAULT '',
    submitter_email TEXT NOT NULL DEFAULT '',
    upvote_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_feature_requests_tenant ON feature_requests(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_feature_requests_workspace ON feature_requests(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status);
  CREATE INDEX IF NOT EXISTS idx_feature_requests_upvotes ON feature_requests(upvote_count);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_feature_requests_slug ON feature_requests(slug);

  CREATE TABLE IF NOT EXISTS feature_request_votes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    feature_request_id TEXT NOT NULL REFERENCES feature_requests(id),
    voter_email TEXT NOT NULL,
    voter_label TEXT NOT NULL DEFAULT '',
    notify_on_change INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_feature_request_votes_tenant ON feature_request_votes(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_feature_request_votes_workspace ON feature_request_votes(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_feature_request_votes_request ON feature_request_votes(feature_request_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_feature_request_votes_voter ON feature_request_votes(feature_request_id, voter_email);

  CREATE TABLE IF NOT EXISTS feature_feedback_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    feature_key TEXT NOT NULL,
    sentiment TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    submitter_label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_feature_feedback_events_tenant ON feature_feedback_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_feature_feedback_events_workspace ON feature_feedback_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_feature_feedback_events_feature ON feature_feedback_events(feature_key);
  CREATE INDEX IF NOT EXISTS idx_feature_feedback_events_sentiment ON feature_feedback_events(sentiment);

  CREATE TABLE IF NOT EXISTS service_status_components (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    component_key TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'operational',
    message TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_service_status_components_tenant ON service_status_components(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_service_status_components_workspace ON service_status_components(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_service_status_components_key ON service_status_components(component_key);

  CREATE TABLE IF NOT EXISTS service_status_incidents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'investigating',
    severity TEXT NOT NULL DEFAULT 'minor',
    affected_components TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    resolved_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_service_status_incidents_tenant ON service_status_incidents(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_service_status_incidents_workspace ON service_status_incidents(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_service_status_incidents_status ON service_status_incidents(status);
  CREATE INDEX IF NOT EXISTS idx_service_status_incidents_started ON service_status_incidents(started_at);

  -- Seed the four canonical status components under the system tenant so
  -- the in-app status page has something to render before any operator
  -- action. The seeded rows are idempotent — re-applying the migration
  -- after they have been edited leaves the edits in place.
  INSERT OR IGNORE INTO service_status_components
    (id, tenant_id, workspace_id, component_key, label, status, sort_order)
  VALUES
    ('ssc_marketplace', 'tenant_system', 'workspace_system', 'marketplace', 'Skill Marketplace', 'operational', 10),
    ('ssc_sync',        'tenant_system', 'workspace_system', 'sync',        'Mobile Sync',        'operational', 20),
    ('ssc_payments',    'tenant_system', 'workspace_system', 'payments',    'Payments',           'operational', 30),
    ('ssc_updates',     'tenant_system', 'workspace_system', 'updates',     'Update Server',      'operational', 40);
`;

const down = `
  DROP TABLE IF EXISTS service_status_incidents;
  DROP TABLE IF EXISTS service_status_components;
  DROP TABLE IF EXISTS feature_feedback_events;
  DROP TABLE IF EXISTS feature_request_votes;
  DROP TABLE IF EXISTS feature_requests;
  DROP TABLE IF EXISTS support_response_templates;
  DROP TABLE IF EXISTS support_ticket_events;
  DROP TABLE IF EXISTS support_tickets;
`;

export const migration: SchemaMigration = {
  id: 44,
  name: "support_system",
  up,
  down,
};
