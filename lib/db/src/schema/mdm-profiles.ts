/**
 * `mdm_profiles` — per-tenant Mobile Device Management configuration profile
 * (Task #56).
 *
 * Enterprise IT departments push a single configuration profile to every
 * machine in their fleet via Jamf Pro (.mobileconfig) or Microsoft Intune /
 * SCCM (Group Policy + Registry). The desktop shell reads the profile from
 * the OS at launch and POSTs it to this endpoint; the server caches it
 * here so the Settings UI can render the admin-locked overlay and so the
 * Enterprise Admin portal can show the active org policy.
 *
 * Exactly one row per tenant — `unique(tenant_id)` enforces the invariant
 * that an organisation has a single source of truth for its OP policy.
 *
 * `values_json` is an opaque JSON object keyed by the configuration field
 * key (`organisationName`, `enterpriseAdminUrl`, `airGapMode`, …).
 * `locked_keys_json` is a JSON string array of keys that the local user
 * may NOT override in Settings — the admin lock layer reads it and marks
 * those fields read-only with the org's name + policy hint.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const mdmProfiles = sqliteTable(
  "mdm_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    /** The MDM channel that supplied this profile (jamf, intune, gpo, manual). */
    source: text("source").notNull().default("manual"),
    /** Human-readable organisation name, surfaced in OP UI as "Managed by X". */
    organisationName: text("organisation_name").notNull(),
    /** Profile schema revision the desktop shell wrote — bumped on remote update. */
    profileVersion: integer("profile_version").notNull().default(1),
    /** JSON object: configuration key → value. */
    valuesJson: text("values_json").notNull().default("{}"),
    /** JSON string array of keys that are admin-locked (read-only in OP UI). */
    lockedKeysJson: text("locked_keys_json").notNull().default("[]"),
    /** ISO-8601 timestamp the desktop shell last reported the profile. */
    lastAppliedAt: integer("last_applied_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_mdm_profiles_tenant").on(t.tenantId),
    uniqTenant: uniqueIndex("uniq_mdm_profiles_tenant").on(t.tenantId),
  }),
);

export type MdmProfile = typeof mdmProfiles.$inferSelect;
export type NewMdmProfile = typeof mdmProfiles.$inferInsert;
