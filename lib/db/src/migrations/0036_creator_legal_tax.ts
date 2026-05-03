/**
 * Migration 0036 — Creator Legal Operations & Tax Compliance (Task #26).
 *
 * Adds the legal/tax compliance layer for the creator marketplace.
 * Without these tables Omninity cannot legally pay creators, has no
 * formal record of agreed-to creator terms, no DMCA takedown trail,
 * and no tax-document storage.
 *
 *  - creator_agreement_signatures   : append-only signed Creator Agreement
 *                                     ledger (re-sign on version bump).
 *  - dmca_takedowns                 : public DMCA notice submissions; the
 *                                     primary record for the takedown
 *                                     workflow + repeat-infringer counter.
 *  - dmca_counter_notices           : creator counter-notice submissions
 *                                     attached to a takedown.
 *  - creator_tax_forms              : encrypted W-9 / W-8BEN tax-id
 *                                     collection (one active row per
 *                                     creator_id; superseded rows kept).
 *  - creator_tax_documents          : generated 1099-K / annual tax docs
 *                                     delivered to the creator.
 *  - tax_collections                : VAT/GST/sales-tax recorded per
 *                                     subscription transaction for the
 *                                     OSS/HMRC/ATO remittance reports.
 *  - creator_payout_settings        : payout threshold, schedule, last
 *                                     payout, jurisdiction restriction
 *                                     flags (singleton per creator).
 *  - creator_payout_screenings      : append-only sanctions/OFAC screening
 *                                     results for each payout request.
 *
 * `creator_agreement_signatures`, `dmca_takedowns`, `dmca_counter_notices`,
 * `creator_tax_documents`, `tax_collections` and `creator_payout_screenings`
 * are append-only audit-class tables (Standard 6 carve-out — same pattern
 * as `legal_acceptances` / `audit_log_entries`). They omit the `version`
 * column intentionally; status fields are immutable on the original row,
 * status transitions are recorded as new rows.
 *
 * `dmca_takedowns` keeps a mutable `status` column because the admin
 * workflow needs to advance it (received → reviewing → upheld / rejected).
 * To preserve the audit trail, every status change writes a new row to
 * `activity_events` rather than rewriting history.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS creator_agreement_signatures (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    creator_id TEXT NOT NULL REFERENCES creator_accounts(id),
    agreement_version TEXT NOT NULL,
    agreement_hash TEXT NOT NULL,
    signed_name TEXT NOT NULL,
    signed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    ip_address TEXT,
    user_agent TEXT,
    locale TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_creator_agreement_sigs_tenant ON creator_agreement_signatures(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_creator_agreement_sigs_workspace ON creator_agreement_signatures(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_creator_agreement_sigs_creator ON creator_agreement_signatures(creator_id);
  CREATE INDEX IF NOT EXISTS idx_creator_agreement_sigs_version ON creator_agreement_signatures(creator_id, agreement_version);

  CREATE TABLE IF NOT EXISTS dmca_takedowns (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    /** Target — store-skill row this notice applies to. */
    store_skill_id TEXT,
    creator_handle TEXT,
    skill_slug TEXT,
    skill_url TEXT,
    /** Submitter (claimant) details — required by 17 USC 512(c)(3). */
    claimant_name TEXT NOT NULL,
    claimant_email TEXT NOT NULL,
    claimant_address TEXT NOT NULL,
    claimant_phone TEXT,
    /** Description of the copyrighted work and infringement. */
    work_description TEXT NOT NULL,
    infringement_description TEXT NOT NULL,
    /** Statutory good-faith + accuracy declarations. */
    good_faith_statement INTEGER NOT NULL DEFAULT 0,
    accuracy_statement INTEGER NOT NULL DEFAULT 0,
    signature TEXT NOT NULL,
    /** received | reviewing | upheld | rejected | counter_noticed | restored */
    status TEXT NOT NULL DEFAULT 'received',
    decision_notes TEXT,
    decided_at INTEGER,
    decided_by TEXT,
    /** Skill removed at this timestamp (null if not yet removed). */
    skill_removed_at INTEGER,
    /** Link back to the counter-notice that flipped this row. */
    counter_notice_id TEXT,
    submitter_ip TEXT,
    submitter_user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dmca_takedowns_tenant ON dmca_takedowns(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dmca_takedowns_workspace ON dmca_takedowns(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dmca_takedowns_status ON dmca_takedowns(status);
  CREATE INDEX IF NOT EXISTS idx_dmca_takedowns_target ON dmca_takedowns(creator_handle, skill_slug);
  CREATE INDEX IF NOT EXISTS idx_dmca_takedowns_created ON dmca_takedowns(created_at);
  CREATE INDEX IF NOT EXISTS idx_dmca_takedowns_store_skill ON dmca_takedowns(store_skill_id);

  CREATE TABLE IF NOT EXISTS dmca_counter_notices (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    takedown_id TEXT NOT NULL REFERENCES dmca_takedowns(id),
    creator_id TEXT REFERENCES creator_accounts(id),
    creator_name TEXT NOT NULL,
    creator_email TEXT NOT NULL,
    creator_address TEXT NOT NULL,
    statement TEXT NOT NULL,
    consent_to_jurisdiction INTEGER NOT NULL DEFAULT 0,
    perjury_statement INTEGER NOT NULL DEFAULT 0,
    signature TEXT NOT NULL,
    /** received | forwarded | resolved | withdrawn */
    status TEXT NOT NULL DEFAULT 'received',
    submitter_ip TEXT,
    submitter_user_agent TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_dmca_counter_tenant ON dmca_counter_notices(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_dmca_counter_workspace ON dmca_counter_notices(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_dmca_counter_takedown ON dmca_counter_notices(takedown_id);
  CREATE INDEX IF NOT EXISTS idx_dmca_counter_creator ON dmca_counter_notices(creator_id);

  CREATE TABLE IF NOT EXISTS creator_tax_forms (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    creator_id TEXT NOT NULL REFERENCES creator_accounts(id),
    /** w9 | w8ben */
    form_type TEXT NOT NULL,
    /** Encrypted JSON blob — { fullName, businessName?, address, taxId } */
    encrypted_payload TEXT NOT NULL,
    /** SHA-256 fingerprint of the decrypted tax id (for dedup, not lookup). */
    tax_id_fingerprint TEXT NOT NULL,
    country_code TEXT NOT NULL,
    /** active | superseded | invalid */
    status TEXT NOT NULL DEFAULT 'active',
    /** True if the IRS schema check passed; false triggers backup withholding. */
    valid INTEGER NOT NULL DEFAULT 1,
    /** Backup-withholding rate applied at payout when valid = 0 (basis points). */
    backup_withholding_bps INTEGER NOT NULL DEFAULT 0,
    submitted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_creator_tax_forms_tenant ON creator_tax_forms(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_creator_tax_forms_workspace ON creator_tax_forms(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_creator_tax_forms_creator ON creator_tax_forms(creator_id);
  CREATE INDEX IF NOT EXISTS idx_creator_tax_forms_status ON creator_tax_forms(creator_id, status);

  CREATE TABLE IF NOT EXISTS creator_tax_documents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    creator_id TEXT NOT NULL REFERENCES creator_accounts(id),
    /** form_1099_k | form_1099_misc | annual_summary */
    document_type TEXT NOT NULL,
    tax_year INTEGER NOT NULL,
    gross_amount_cents INTEGER NOT NULL DEFAULT 0,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    backup_withholding_cents INTEGER NOT NULL DEFAULT 0,
    /** Generated PDF bytes (stub: text/markdown body). */
    body TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    /** issued | delivered | filed_with_irs */
    status TEXT NOT NULL DEFAULT 'issued',
    delivered_at INTEGER,
    filed_at INTEGER,
    irs_confirmation_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_creator_tax_docs_tenant ON creator_tax_documents(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_creator_tax_docs_workspace ON creator_tax_documents(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_creator_tax_docs_creator ON creator_tax_documents(creator_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_creator_tax_docs_year_type
    ON creator_tax_documents(creator_id, tax_year, document_type);

  CREATE TABLE IF NOT EXISTS tax_collections (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    /** Origin record — subscription / store install / one-off. */
    source TEXT NOT NULL,
    source_ref TEXT,
    /** ISO-3166-1 alpha-2 country code of the buyer. */
    buyer_country TEXT NOT NULL,
    buyer_region TEXT,
    /** vat | gst | sales_tax | none */
    tax_type TEXT NOT NULL,
    /** Tax rate in basis points (2000 = 20%). */
    tax_rate_bps INTEGER NOT NULL DEFAULT 0,
    net_amount_cents INTEGER NOT NULL,
    tax_amount_cents INTEGER NOT NULL,
    gross_amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    /** Filing bucket — eu_oss | uk_vat | au_gst | us_sales_tax | none */
    remittance_bucket TEXT NOT NULL DEFAULT 'none',
    invoice_number TEXT,
    invoice_url TEXT,
    is_business INTEGER NOT NULL DEFAULT 0,
    business_vat_number TEXT,
    collected_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_tax_collections_tenant ON tax_collections(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_tax_collections_workspace ON tax_collections(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_tax_collections_country ON tax_collections(buyer_country, collected_at);
  CREATE INDEX IF NOT EXISTS idx_tax_collections_bucket ON tax_collections(remittance_bucket, collected_at);

  CREATE TABLE IF NOT EXISTS creator_payout_settings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    creator_id TEXT NOT NULL REFERENCES creator_accounts(id),
    /** stripe_connect | bank_transfer | gift_card | account_credit | restricted */
    method TEXT NOT NULL DEFAULT 'stripe_connect',
    /** ISO 4217 currency for payouts. */
    currency TEXT NOT NULL DEFAULT 'usd',
    /** Minimum payout amount in cents. */
    minimum_threshold_cents INTEGER NOT NULL DEFAULT 5000,
    /** monthly | weekly | manual */
    schedule TEXT NOT NULL DEFAULT 'monthly',
    /** ISO-3166-1 alpha-2 of the recipient. */
    recipient_country TEXT NOT NULL,
    /** True when restrictions force gift-card / account-credit fallback. */
    restricted INTEGER NOT NULL DEFAULT 0,
    restriction_reason TEXT,
    last_payout_at INTEGER,
    last_payout_cents INTEGER NOT NULL DEFAULT 0,
    /** ban | suspended | active — from the repeat-infringer policy. */
    publish_status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_creator_payout_tenant ON creator_payout_settings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_creator_payout_workspace ON creator_payout_settings(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_creator_payout_creator ON creator_payout_settings(creator_id);

  CREATE TABLE IF NOT EXISTS creator_payout_screenings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    creator_id TEXT NOT NULL REFERENCES creator_accounts(id),
    /** ofac_sdn | ofac_consolidated | uk_hmt | eu_consolidated */
    list_name TEXT NOT NULL,
    /** clear | hit | manual_review */
    result TEXT NOT NULL,
    matched_name TEXT,
    matched_country TEXT,
    notes TEXT,
    screened_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_creator_payout_screen_tenant ON creator_payout_screenings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_creator_payout_screen_workspace ON creator_payout_screenings(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_creator_payout_screen_creator ON creator_payout_screenings(creator_id, screened_at);
  CREATE INDEX IF NOT EXISTS idx_creator_payout_screen_result ON creator_payout_screenings(result, screened_at);
`;

const down = `
  DROP TABLE IF EXISTS creator_payout_screenings;
  DROP TABLE IF EXISTS creator_payout_settings;
  DROP TABLE IF EXISTS tax_collections;
  DROP TABLE IF EXISTS creator_tax_documents;
  DROP TABLE IF EXISTS creator_tax_forms;
  DROP TABLE IF EXISTS dmca_counter_notices;
  DROP TABLE IF EXISTS dmca_takedowns;
  DROP TABLE IF EXISTS creator_agreement_signatures;
`;

export const migration: SchemaMigration = {
  id: 36,
  name: "creator_legal_tax",
  up,
  down,
};
