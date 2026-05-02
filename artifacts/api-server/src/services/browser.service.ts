/**
 * Browser tool — Tier 1 stub.
 *
 * The full Playwright integration ships with the dedicated Browser task
 * later in the roadmap; for Tier 1 we expose a deterministic API surface
 * that returns a "scheduled" receipt so route + UI work can be built
 * against the final shape. Every call is still privacy-logged because a
 * future implementation will reach the public network.
 */
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "./privacy.service";

export interface BrowserActionReceipt {
  status: string;
  scheduledAt: string;
  detail: string;
}

export async function screenshot(
  ctx: TenantContext,
  url: string,
  viewport?: string,
): Promise<BrowserActionReceipt> {
  await logPrivacyEvent(ctx, {
    eventType: "browser.screenshot",
    actor: ctx.userId ?? ctx.tenantId,
    target: url,
    severity: "medium",
    ...(viewport !== undefined ? { detail: viewport } : {}),
  });
  return {
    status: "scheduled",
    scheduledAt: new Date().toISOString(),
    detail: `Browser tool is in stub mode for Tier 1; queued screenshot of ${url}.`,
  };
}

export async function extract(
  ctx: TenantContext,
  url: string,
  selector: string,
): Promise<BrowserActionReceipt> {
  await logPrivacyEvent(ctx, {
    eventType: "browser.extract",
    actor: ctx.userId ?? ctx.tenantId,
    target: url,
    severity: "medium",
    detail: `selector=${selector}`,
  });
  return {
    status: "scheduled",
    scheduledAt: new Date().toISOString(),
    detail: `Browser tool is in stub mode for Tier 1; queued extract of ${selector} from ${url}.`,
  };
}
