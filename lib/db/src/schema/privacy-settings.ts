/**
 * `privacy_settings` — singleton-per-tenant per-feature privacy toggles.
 *
 * Sits alongside `telemetry_consent` (which covers the three telemetry
 * channels) and adds the rest of the fine-grained toggles surfaced on the
 * Privacy Dashboard:
 *
 *   - allowExternalModels        — let the agent call cloud models.
 *   - allowMarketplaceUsageStats — share install / rating events.
 *   - allowIntegrationDataReads  — gate every connected-integration read.
 *   - allowSkillNetworkCalls     — let installed skills make outbound calls.
 *
 * All toggles default to OFF (Standard 12 § "Default deny"). The absence
 * of a row is interpreted as everything-off so a service that forgets to
 * check the flag simply won't perform the action.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const privacySettings = sqliteTable(
  "privacy_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    allowExternalModels: integer("allow_external_models").notNull().default(0),
    allowMarketplaceUsageStats: integer("allow_marketplace_usage_stats").notNull().default(0),
    allowIntegrationDataReads: integer("allow_integration_data_reads").notNull().default(1),
    allowSkillNetworkCalls: integer("allow_skill_network_calls").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_privacy_settings_tenant").on(t.tenantId),
    workspaceIdx: index("idx_privacy_settings_workspace").on(t.workspaceId),
    uniqTenant: uniqueIndex("idx_privacy_settings_unique_tenant").on(t.tenantId),
  }),
);

export type PrivacySettings = typeof privacySettings.$inferSelect;
export type NewPrivacySettings = typeof privacySettings.$inferInsert;
