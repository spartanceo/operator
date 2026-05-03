/**
 * Schema barrel — every table the database knows about is exported from here.
 *
 * Conventions enforced by the tier-review gate (Standard 6 / Check #5):
 *  - Every table has columns: `id`, `tenantId`, `createdAt`, `updatedAt`.
 *  - Mutable records also have a `version` column for optimistic concurrency.
 *  - Every `tenant_id` / `workspace_id` / `.references(...)` column has a
 *    matching `index(...)` entry inside the table's index callback
 *    (Standard 13 / Check #17).
 *
 * See `../README.md` for the canonical pattern to copy when adding a table.
 */
export * from "./tenants";
export * from "./workspaces";
export * from "./users";
export * from "./sessions";
export * from "./conversations";
export * from "./agent-runs";
export * from "./messages";
export * from "./tool-calls";
export * from "./memories";
export * from "./privacy-events";
export * from "./approvals";
export * from "./onboarding-profiles";
export * from "./model-preferences";
export * from "./desktop-sessions";
export * from "./desktop-steps";
export * from "./kb-collections";
export * from "./kb-documents";
export * from "./kb-chunks";
export * from "./media-assets";
export * from "./comm-accounts";
export * from "./email-messages";
export * from "./email-drafts";
export * from "./outreach-sequences";
export * from "./outreach-enrolments";
export * from "./calendar-events";
export * from "./voip-calls";
export * from "./contacts";
export * from "./interactions";
export * from "./audit-log-entries";
export * from "./security-events";
export * from "./secret-vault-entries";
export * from "./master-password-state";
export * from "./webhook-secrets";
export * from "./telemetry-consent";
export * from "./auto-lock-state";
export * from "./admin-2fa-secrets";
export * from "./refresh-tokens";
export * from "./notifications";
export * from "./activity-events";
export * from "./paired-devices";
export * from "./pairing-tokens";
export * from "./mobile-push-subscriptions";
export * from "./mobile-notification-prefs";
export * from "./mobile-quick-tasks";
export * from "./telemetry-settings";
export * from "./telemetry-events";
export * from "./crash-reports";
export * from "./legal-acceptances";
export * from "./incident-reports";
export * from "./age-confirmations";
export * from "./undo-actions";
