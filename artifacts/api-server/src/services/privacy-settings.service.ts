/**
 * Privacy settings service — singleton-per-tenant per-feature toggles.
 *
 * Standard 12 § "Default deny": every channel is OFF by default. Absence
 * of a row is equivalent to the documented defaults below.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  privacySettings,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";

export interface PrivacySettingsState {
  readonly allowExternalModels: boolean;
  readonly allowMarketplaceUsageStats: boolean;
  readonly allowIntegrationDataReads: boolean;
  readonly allowSkillNetworkCalls: boolean;
  readonly updatedAt: string;
}

const DEFAULT_STATE: Omit<PrivacySettingsState, "updatedAt"> = {
  allowExternalModels: false,
  allowMarketplaceUsageStats: false,
  allowIntegrationDataReads: true,
  allowSkillNetworkCalls: false,
};

export async function getPrivacySettings(
  ctx: TenantContext,
): Promise<PrivacySettingsState> {
  const rows = await db
    .select()
    .from(privacySettings)
    .where(tenantScope(ctx, privacySettings))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { ...DEFAULT_STATE, updatedAt: new Date(0).toISOString() };
  }
  return {
    allowExternalModels: row.allowExternalModels === 1,
    allowMarketplaceUsageStats: row.allowMarketplaceUsageStats === 1,
    allowIntegrationDataReads: row.allowIntegrationDataReads === 1,
    allowSkillNetworkCalls: row.allowSkillNetworkCalls === 1,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export interface UpdatePrivacySettingsInput {
  readonly allowExternalModels?: boolean;
  readonly allowMarketplaceUsageStats?: boolean;
  readonly allowIntegrationDataReads?: boolean;
  readonly allowSkillNetworkCalls?: boolean;
}

export async function updatePrivacySettings(
  ctx: TenantContext,
  input: UpdatePrivacySettingsInput,
): Promise<PrivacySettingsState> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(privacySettings)
    .where(tenantScope(ctx, privacySettings))
    .limit(1);
  const row = existing[0];

  const desired = {
    allowExternalModels:
      input.allowExternalModels ??
      (row ? row.allowExternalModels === 1 : DEFAULT_STATE.allowExternalModels),
    allowMarketplaceUsageStats:
      input.allowMarketplaceUsageStats ??
      (row
        ? row.allowMarketplaceUsageStats === 1
        : DEFAULT_STATE.allowMarketplaceUsageStats),
    allowIntegrationDataReads:
      input.allowIntegrationDataReads ??
      (row
        ? row.allowIntegrationDataReads === 1
        : DEFAULT_STATE.allowIntegrationDataReads),
    allowSkillNetworkCalls:
      input.allowSkillNetworkCalls ??
      (row
        ? row.allowSkillNetworkCalls === 1
        : DEFAULT_STATE.allowSkillNetworkCalls),
  };

  if (row) {
    await db
      .update(privacySettings)
      .set({
        allowExternalModels: desired.allowExternalModels ? 1 : 0,
        allowMarketplaceUsageStats: desired.allowMarketplaceUsageStats ? 1 : 0,
        allowIntegrationDataReads: desired.allowIntegrationDataReads ? 1 : 0,
        allowSkillNetworkCalls: desired.allowSkillNetworkCalls ? 1 : 0,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(
        and(tenantScope(ctx, privacySettings), eq(privacySettings.id, row.id)),
      );
  } else {
    await db.insert(privacySettings).values(
      withTenantValues(ctx, {
        id: `prs_${nanoid()}`,
        allowExternalModels: desired.allowExternalModels ? 1 : 0,
        allowMarketplaceUsageStats: desired.allowMarketplaceUsageStats ? 1 : 0,
        allowIntegrationDataReads: desired.allowIntegrationDataReads ? 1 : 0,
        allowSkillNetworkCalls: desired.allowSkillNetworkCalls ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: "privacy.settings.updated",
    resourceType: "privacy_settings",
    resourceId: ctx.tenantId,
    summary:
      `extModels=${desired.allowExternalModels} ` +
      `marketplace=${desired.allowMarketplaceUsageStats} ` +
      `integReads=${desired.allowIntegrationDataReads} ` +
      `skillNet=${desired.allowSkillNetworkCalls}`,
  });

  return getPrivacySettings(ctx);
}
