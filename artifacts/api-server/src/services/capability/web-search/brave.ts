/**
 * Brave Search API backend (cloud-assist — user-owned key).
 *
 * Brave Search provides an independent web search index at
 * https://api.search.brave.com. Unlike Serper/Bing it does NOT
 * proxy Google — results come from Brave's own crawler.
 *
 * Free tier: 2 000 queries/month. Paid from $3/month.
 * API key obtained at https://api.search.brave.com/app/keys
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type { CapabilityHealth, WebSearchResult, WebSearchRuntime } from "../types";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export const braveRuntime: WebSearchRuntime = {
  id: "brave-search",
  displayName: "Brave Search API",
  capabilityType: "web-search",
  residency: "cloud-assist",
  requiresApiKey: true,

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  },

  async health(_ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth> {
    if (!apiKey) {
      return {
        status: "needs-credentials",
        detail: "Brave Search API key required — get one at https://api.search.brave.com/app/keys",
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
      throw new Error("Brave Search API key is required but not configured");
    }

    const searchUrl =
      `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${numResults}`;

    await logPrivacyEvent(ctx, {
      eventType: "tool.web_search",
      actor: ctx.userId ?? ctx.tenantId,
      target: query,
      severity: "low",
      detail: `provider=brave count=${numResults}`,
    });

    const res = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Brave Search API ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description?: string }> };
    };

    return (data.web?.results ?? []).slice(0, numResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? "",
    }));
  },
};
