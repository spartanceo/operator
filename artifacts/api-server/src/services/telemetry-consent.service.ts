/**
 * Telemetry consent service — singleton-per-tenant opt-in toggles.
 *
 * Standard 12 § "Default deny": every channel is OFF by default. The
 * absence of a row is interpreted as no consent, so a producer that
 * forgets to check `isConsentGivenFor()` will simply not send.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  telemetryConsent,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";

export type TelemetryChannel = "crashReports" | "usageMetrics" | "productImprovement";

export interface TelemetryConsentState {
  readonly crashReportsEnabled: boolean;
  readonly usageMetricsEnabled: boolean;
  readonly productImprovementEnabled: boolean;
  readonly consentGivenAt: string | null;
  readonly consentRevokedAt: string | null;
  readonly consentVersion: string;
}

const DEFAULT_STATE: TelemetryConsentState = {
  crashReportsEnabled: false,
  usageMetricsEnabled: false,
  productImprovementEnabled: false,
  consentGivenAt: null,
  consentRevokedAt: null,
  consentVersion: "v1",
};

export async function getTelemetryConsent(
  ctx: TenantContext,
): Promise<TelemetryConsentState> {
  const rows = await db
    .select()
    .from(telemetryConsent)
    .where(tenantScope(ctx, telemetryConsent))
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_STATE;
  return {
    crashReportsEnabled: row.crashReportsEnabled === 1,
    usageMetricsEnabled: row.usageMetricsEnabled === 1,
    productImprovementEnabled: row.productImprovementEnabled === 1,
    consentGivenAt: row.consentGivenAt ? new Date(row.consentGivenAt).toISOString() : null,
    consentRevokedAt: row.consentRevokedAt ? new Date(row.consentRevokedAt).toISOString() : null,
    consentVersion: row.consentVersion,
  };
}

export interface UpdateConsentInput {
  readonly crashReportsEnabled?: boolean;
  readonly usageMetricsEnabled?: boolean;
  readonly productImprovementEnabled?: boolean;
}

export async function updateTelemetryConsent(
  ctx: TenantContext,
  input: UpdateConsentInput,
): Promise<TelemetryConsentState> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(telemetryConsent)
    .where(tenantScope(ctx, telemetryConsent))
    .limit(1);
  const row = existing[0];
  const desired = {
    crashReportsEnabled:
      input.crashReportsEnabled ?? (row ? row.crashReportsEnabled === 1 : false),
    usageMetricsEnabled:
      input.usageMetricsEnabled ?? (row ? row.usageMetricsEnabled === 1 : false),
    productImprovementEnabled:
      input.productImprovementEnabled ??
      (row ? row.productImprovementEnabled === 1 : false),
  };
  const anyOn =
    desired.crashReportsEnabled ||
    desired.usageMetricsEnabled ||
    desired.productImprovementEnabled;
  if (row) {
    await db
      .update(telemetryConsent)
      .set({
        crashReportsEnabled: desired.crashReportsEnabled ? 1 : 0,
        usageMetricsEnabled: desired.usageMetricsEnabled ? 1 : 0,
        productImprovementEnabled: desired.productImprovementEnabled ? 1 : 0,
        consentGivenAt: anyOn ? row.consentGivenAt ?? now : row.consentGivenAt,
        consentRevokedAt: anyOn ? null : row.consentRevokedAt ?? now,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(and(tenantScope(ctx, telemetryConsent), eq(telemetryConsent.id, row.id)));
  } else {
    await db.insert(telemetryConsent).values(
      withTenantValues(ctx, {
        id: `tlc_${nanoid()}`,
        crashReportsEnabled: desired.crashReportsEnabled ? 1 : 0,
        usageMetricsEnabled: desired.usageMetricsEnabled ? 1 : 0,
        productImprovementEnabled: desired.productImprovementEnabled ? 1 : 0,
        consentGivenAt: anyOn ? now : null,
        consentRevokedAt: anyOn ? null : now,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: anyOn ? "telemetry.consent.given" : "telemetry.consent.revoked",
    resourceType: "telemetry_consent",
    resourceId: ctx.tenantId,
    summary: `crash=${desired.crashReportsEnabled} usage=${desired.usageMetricsEnabled} product=${desired.productImprovementEnabled}`,
  });
  return getTelemetryConsent(ctx);
}

export async function isConsentGivenFor(
  ctx: TenantContext,
  channel: TelemetryChannel,
): Promise<boolean> {
  const state = await getTelemetryConsent(ctx);
  switch (channel) {
    case "crashReports":
      return state.crashReportsEnabled;
    case "usageMetrics":
      return state.usageMetricsEnabled;
    case "productImprovement":
      return state.productImprovementEnabled;
  }
}
