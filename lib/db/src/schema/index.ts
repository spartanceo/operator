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
export * from "./integrations";
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
export * from "./audit-retention-settings";
export * from "./audit-alert-rules";
export * from "./audit-alerts";
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
export * from "./skills";
export * from "./skill-versions";
export * from "./skill-ratings";
export * from "./task-queue-entries";
export * from "./task-checkpoints";
export * from "./clean-shutdown-log";
export * from "./task-template-categories";
export * from "./task-templates";
export * from "./scheduled-tasks";

export * from "./skill-drafts";
export * from "./creator-accounts";
export * from "./store-skills";
export * from "./subscriptions";
export * from "./skill-preview-counters";
export * from "./skill-configurations";
export * from "./mdm-profiles";
export * from "./mdm-fleet-devices";

export * from "./referral-codes";
export * from "./referrals";
export * from "./referral-rewards";
export * from "./acquisition-channels";
export * from "./share-events";
export * from "./task-satisfaction-ratings";
export * from "./creator-profiles";
export * from "./creator-milestones";
export * from "./enterprise-trial-invites";
export * from "./waitlist-signups";
export * from "./beta-access-grants";

export * from "./plugin-tools";
export * from "./webhook-subscriptions";
export * from "./desktop-integration-settings";
export * from "./desktop-quick-invocations";

export * from "./update-releases";
export * from "./update-install-attempts";
export * from "./update-pinning";

export * from "./backup-settings";
export * from "./backup-jobs";

export * from "./creator-agreement-signatures";
export * from "./dmca-takedowns";
export * from "./dmca-counter-notices";
export * from "./creator-tax-forms";
export * from "./creator-tax-documents";
export * from "./tax-collections";
export * from "./creator-payout-settings";
export * from "./creator-payout-screenings";

export * from "./privacy-settings";
export * from "./network-calls";
export * from "./skill-permissions";
export * from "./erasure-requests";

export * from "./feature-flags";
export * from "./app-versions";
export * from "./enterprise-orgs";
export * from "./abuse-reports";
export * from "./skill-moderation";

export * from "./dr-replicas";
export * from "./dr-snapshots";
export * from "./dr-runbooks";
export * from "./dr-drills";
export * from "./dr-storage-nodes";
export * from "./dr-incidents";
export * from "./dr-alerts";

export * from "./sso-configurations";
export * from "./sso-group-role-mappings";
export * from "./sso-login-events";
export * from "./sso-sessions";
export * from "./scim-provisioning-tokens";
export * from "./scim-groups";
export * from "./break-glass-accounts";

export * from "./support-tickets";
export * from "./support-ticket-events";
export * from "./support-response-templates";
export * from "./feature-requests";
export * from "./feature-request-votes";
export * from "./feature-feedback-events";
export * from "./service-status-components";
export * from "./service-status-incidents";
