/**
 * Migration 0002 — communication hub.
 *
 * Adds the nine tables that back Task #11's Communication & Calendar
 * Integration: connected accounts (Gmail / Outlook / Google Calendar /
 * Apple Calendar / Twilio VoIP), email messages and drafts, calendar
 * events, VoIP calls with Whisper transcription stubs, contacts, the
 * append-only interaction log, and outreach sequences with their
 * per-contact enrolments.
 *
 * Every table is tenant + workspace scoped, indexed on the dimensions the
 * services actually filter by (tenant, workspace, account, status, time
 * cursors), and carries a `version` column where rows are mutable. The
 * `interactions` table is append-only and intentionally omits `version`.
 *
 * The up script uses IF NOT EXISTS so it is safe to re-run on a database
 * that already received these tables via the legacy idempotent runner
 * (pre-Task #37). The down script drops in reverse-FK order for clean
 * teardown via `rollbackTo`.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS comm_accounts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_comm_accounts_tenant ON comm_accounts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_comm_accounts_workspace ON comm_accounts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_comm_accounts_provider ON comm_accounts(tenant_id, provider);
  CREATE INDEX IF NOT EXISTS idx_comm_accounts_status ON comm_accounts(tenant_id, status);

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    display_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    notes TEXT,
    last_interaction_at INTEGER,
    follow_up_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(tenant_id, email);
  CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(tenant_id, phone);
  CREATE INDEX IF NOT EXISTS idx_contacts_follow_up ON contacts(tenant_id, follow_up_at);

  CREATE TABLE IF NOT EXISTS email_messages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    account_id TEXT NOT NULL REFERENCES comm_accounts(id),
    provider_message_id TEXT,
    thread_id TEXT,
    direction TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL,
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL,
    body TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT 'inbox',
    status TEXT NOT NULL DEFAULT 'unread',
    category TEXT,
    received_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_email_messages_tenant ON email_messages(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_email_messages_workspace ON email_messages(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages(account_id);
  CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(tenant_id, thread_id);
  CREATE INDEX IF NOT EXISTS idx_email_messages_folder ON email_messages(tenant_id, folder);
  CREATE INDEX IF NOT EXISTS idx_email_messages_received ON email_messages(tenant_id, received_at);

  CREATE TABLE IF NOT EXISTS email_drafts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    account_id TEXT NOT NULL REFERENCES comm_accounts(id),
    reply_to_message_id TEXT REFERENCES email_messages(id),
    sequence_id TEXT,
    enrolment_id TEXT,
    to_addresses TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending',
    decided_at INTEGER,
    sent_at INTEGER,
    provider_message_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_email_drafts_tenant ON email_drafts(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_email_drafts_workspace ON email_drafts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_email_drafts_account ON email_drafts(account_id);
  CREATE INDEX IF NOT EXISTS idx_email_drafts_reply_to ON email_drafts(reply_to_message_id);
  CREATE INDEX IF NOT EXISTS idx_email_drafts_decision ON email_drafts(tenant_id, decision);

  CREATE TABLE IF NOT EXISTS outreach_sequences (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    account_id TEXT NOT NULL REFERENCES comm_accounts(id),
    name TEXT NOT NULL,
    description TEXT,
    steps_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_outreach_sequences_tenant ON outreach_sequences(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_sequences_workspace ON outreach_sequences(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_sequences_account ON outreach_sequences(account_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_sequences_status ON outreach_sequences(tenant_id, status);

  CREATE TABLE IF NOT EXISTS outreach_enrolments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    sequence_id TEXT NOT NULL REFERENCES outreach_sequences(id),
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    status TEXT NOT NULL DEFAULT 'active',
    current_step INTEGER NOT NULL DEFAULT 0,
    next_send_at INTEGER,
    last_sent_at INTEGER,
    replied_at INTEGER,
    thread_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_outreach_enrolments_tenant ON outreach_enrolments(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_enrolments_workspace ON outreach_enrolments(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_enrolments_sequence ON outreach_enrolments(sequence_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_enrolments_contact ON outreach_enrolments(contact_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_enrolments_status ON outreach_enrolments(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_outreach_enrolments_next_send ON outreach_enrolments(tenant_id, next_send_at);

  CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    account_id TEXT NOT NULL REFERENCES comm_accounts(id),
    provider_event_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    attendees_json TEXT,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_calendar_events_tenant ON calendar_events(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_calendar_events_workspace ON calendar_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_calendar_events_account ON calendar_events(account_id);
  CREATE INDEX IF NOT EXISTS idx_calendar_events_starts ON calendar_events(tenant_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_calendar_events_status ON calendar_events(tenant_id, status);

  CREATE TABLE IF NOT EXISTS voip_calls (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    account_id TEXT NOT NULL REFERENCES comm_accounts(id),
    contact_id TEXT REFERENCES contacts(id),
    provider_call_id TEXT,
    direction TEXT NOT NULL,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    duration_seconds INTEGER,
    transcript TEXT,
    summary TEXT,
    recording_path TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_voip_calls_tenant ON voip_calls(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_voip_calls_workspace ON voip_calls(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_voip_calls_account ON voip_calls(account_id);
  CREATE INDEX IF NOT EXISTS idx_voip_calls_contact ON voip_calls(contact_id);
  CREATE INDEX IF NOT EXISTS idx_voip_calls_status ON voip_calls(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_voip_calls_started ON voip_calls(tenant_id, started_at);

  CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    kind TEXT NOT NULL,
    reference_id TEXT,
    summary TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_tenant ON interactions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_workspace ON interactions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_occurred ON interactions(tenant_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_interactions_kind ON interactions(tenant_id, kind);
`;

const down = `
  DROP TABLE IF EXISTS interactions;
  DROP TABLE IF EXISTS voip_calls;
  DROP TABLE IF EXISTS calendar_events;
  DROP TABLE IF EXISTS outreach_enrolments;
  DROP TABLE IF EXISTS outreach_sequences;
  DROP TABLE IF EXISTS email_drafts;
  DROP TABLE IF EXISTS email_messages;
  DROP TABLE IF EXISTS contacts;
  DROP TABLE IF EXISTS comm_accounts;
`;

export const migration: SchemaMigration = {
  id: 8,
  name: "communication_hub",
  up,
  down,
};
