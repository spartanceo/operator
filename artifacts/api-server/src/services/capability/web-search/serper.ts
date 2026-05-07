/**
 * Serper web search backend (Google wrapper — cloud-required).
 *
 * Serper provides a Google Search API at https://serper.dev.
 * Requires an API key passed as the X-API-KEY header.
 * Free tier: 2 500 queries/month. Paid from $50/month.
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type { CapabilityHealth, WebSearchResult, WebSearchRuntime } from "../types";

const SERPER_ENDPOINT = "https://google.serper.dev/search";

export const serperRuntime: WebSearchRuntime = {
  id: "serper",
  displayName: "Serper (Google wrapper)",
  capabilityType: "web-search",
  residency: "cloud-required",
  requiresApiKey: true,

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  },

  async health(_ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth> {
    if (!apiKey) {
      return {
        status: "needs-credentials",
        detail: "Serper API key required — get one at https://serper.dev",
        detectedAt: new Date().toISOString(),
      };
    }
    return {
      status: "unknown",
      detail: "Cloud backend — health not verified until first search",
      detectedAt: new Date().toISOString(),
    };
  },

  async search(
    ctx: TenantContext,
    query: string,
    numResults: number,
    apiKey?: string | null,
  ): Promise<WebSearchResult[]> {
    if (!apiKey) {
      throw new Error("Serper API key is required but not configured");
    }

    await logPrivacyEvent(ctx, {
      eventType: "tool.web_search",
      actor: ctx.userId ?? ctx.tenantId,
      target: query,
      severity: "low",
      detail: `provider=serper count=${numResults}`,
    });

    const res = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: numResults }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Serper API ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      organic?: Array<{ title: string; link: string; snippet?: string }>;
    };

    return (data.organic ?? []).slice(0, numResults).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet ?? "",
    }));
  },
};
