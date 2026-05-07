/**
 * Bing Web Search API backend (cloud-required — user-owned key).
 *
 * Microsoft Bing Search v7 at https://api.bing.microsoft.com.
 * Requires an Azure subscription key in the Ocp-Apim-Subscription-Key header.
 *
 * Free tier: 1 000 transactions/month (F1). Paid from $3/1 000 queries.
 * Key obtained via Azure portal → AI Services → Bing Search.
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type { CapabilityHealth, WebSearchResult, WebSearchRuntime } from "../types";

const BING_ENDPOINT = "https://api.bing.microsoft.com/v7.0/search";

export const bingRuntime: WebSearchRuntime = {
  id: "bing-search",
  displayName: "Bing Web Search API",
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
        detail: "Bing Search API key required — create one in the Azure portal (AI Services → Bing Search)",
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
      throw new Error("Bing Search API key is required but not configured");
    }

    const searchUrl =
      `${BING_ENDPOINT}?q=${encodeURIComponent(query)}&count=${numResults}&mkt=en-US&safeSearch=Moderate`;

    await logPrivacyEvent(ctx, {
      eventType: "tool.web_search",
      actor: ctx.userId ?? ctx.tenantId,
      target: query,
      severity: "low",
      detail: `provider=bing count=${numResults}`,
    });

    const res = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        "Ocp-Apim-Subscription-Key": apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bing Search API ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      webPages?: {
        value?: Array<{ name: string; url: string; snippet?: string }>;
      };
    };

    return (data.webPages?.value ?? []).slice(0, numResults).map((r) => ({
      title: r.name,
      url: r.url,
      snippet: r.snippet ?? "",
    }));
  },
};
