/**
 * Privacy-meter engine.
 *
 * Computes the colour-coded score that lives in the operator nav bar.
 * Inputs:
 *   - active model location (local vs. cloud — based on `allowExternalModels`
 *     and the active model preference)
 *   - count of connected integrations
 *   - opt-in flags (telemetry consent + privacy settings)
 *   - count of skills with `network.outbound` granted
 *   - count of recent external network calls (last 30 days)
 *
 * Output: a 0–100 score plus a colour band:
 *   90–100 → green ("Fully local")
 *   60–89  → amber ("Some external calls")
 *   0–59   → red   ("Significant external sharing")
 */
import { and, count, eq, gte } from "drizzle-orm";

import {
  db,
  integrations,
  networkCalls,
  skillPermissions,
  tenantScope,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { getPrivacySettings } from "./privacy-settings.service";
import { getTelemetryConsent } from "./telemetry-consent.service";

export type PrivacyBand = "green" | "amber" | "red";

export interface PrivacyMeterBreakdown {
  readonly integrations: { connected: number; deduction: number };
  readonly telemetry: { anyEnabled: boolean; deduction: number };
  readonly externalModels: { allowed: boolean; deduction: number };
  readonly marketplaceUsageStats: { allowed: boolean; deduction: number };
  readonly skillNetwork: { skillsWithNetwork: number; deduction: number };
  readonly recentNetworkCalls: { count: number; deduction: number };
}

export interface PrivacyMeterReading {
  readonly score: number;
  readonly band: PrivacyBand;
  readonly summary: string;
  readonly breakdown: PrivacyMeterBreakdown;
  readonly generatedAt: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function bandFor(score: number): PrivacyBand {
  if (score >= 90) return "green";
  if (score >= 60) return "amber";
  return "red";
}

function summaryFor(band: PrivacyBand): string {
  switch (band) {
    case "green":
      return "Fully local. No external services in use.";
    case "amber":
      return "Some external calls. Review the 'What's been shared' panel.";
    case "red":
      return "Significant external sharing. Open the dashboard to tighten controls.";
  }
}

async function connectedIntegrationCount(ctx: TenantContext): Promise<number> {
  try {
    const rows = await db
      .select({ c: count() })
      .from(integrations)
      .where(tenantScope(ctx, integrations));
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

async function skillsWithNetworkGranted(ctx: TenantContext): Promise<number> {
  try {
    const rows = await db
      .select({ c: count() })
      .from(skillPermissions)
      .where(
        and(
          tenantScope(ctx, skillPermissions),
          eq(skillPermissions.permission, "network.outbound"),
          eq(skillPermissions.granted, 1),
        ),
      );
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

async function recentNetworkCallCount(ctx: TenantContext): Promise<number> {
  try {
    const since = Date.now() - THIRTY_DAYS_MS;
    const rows = await db
      .select({ c: count() })
      .from(networkCalls)
      .where(
        and(
          tenantScope(ctx, networkCalls),
          gte(networkCalls.createdAt, since),
        ),
      );
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

export async function computePrivacyMeter(
  ctx: TenantContext,
): Promise<PrivacyMeterReading> {
  const [connected, telemetry, settings, skillNet, recentCalls] =
    await Promise.all([
      connectedIntegrationCount(ctx),
      getTelemetryConsent(ctx),
      getPrivacySettings(ctx),
      skillsWithNetworkGranted(ctx),
      recentNetworkCallCount(ctx),
    ]);

  const anyTelemetry =
    telemetry.crashReportsEnabled ||
    telemetry.usageMetricsEnabled ||
    telemetry.productImprovementEnabled;

  const breakdown: PrivacyMeterBreakdown = {
    integrations: {
      connected,
      deduction: Math.min(connected * 4, 20),
    },
    telemetry: { anyEnabled: anyTelemetry, deduction: anyTelemetry ? 8 : 0 },
    externalModels: {
      allowed: settings.allowExternalModels,
      deduction: settings.allowExternalModels ? 10 : 0,
    },
    marketplaceUsageStats: {
      allowed: settings.allowMarketplaceUsageStats,
      deduction: settings.allowMarketplaceUsageStats ? 4 : 0,
    },
    skillNetwork: {
      skillsWithNetwork: skillNet,
      deduction: Math.min(skillNet * 3, 15),
    },
    recentNetworkCalls: {
      count: recentCalls,
      deduction: Math.min(Math.floor(recentCalls / 25), 10),
    },
  };

  const totalDeduction =
    breakdown.integrations.deduction +
    breakdown.telemetry.deduction +
    breakdown.externalModels.deduction +
    breakdown.marketplaceUsageStats.deduction +
    breakdown.skillNetwork.deduction +
    breakdown.recentNetworkCalls.deduction;

  const score = Math.max(0, Math.min(100, 100 - totalDeduction));
  const band = bandFor(score);
  return {
    score,
    band,
    summary: summaryFor(band),
    breakdown,
    generatedAt: new Date().toISOString(),
  };
}
