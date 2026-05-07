/**
 * SearXNG self-hosted web search backend.
 *
 * SearXNG is a free, open-source metasearch engine that aggregates
 * results from Google, Bing, DuckDuckGo and others via its JSON API.
 * No API key is required — users run it locally via Docker.
 *
 * Default probe / search base: http://localhost:8080
 * Override via SEARXNG_HOST env var.
 *
 * Docker one-liner to start SearXNG:
 *   docker run -d -p 8080:8080 searxng/searxng
 */
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";
import type { CapabilityHealth, WebSearchResult, WebSearchRuntime } from "../types";

export const SEARXNG_DEFAULT_HOST = "http://localhost:8080";
export const SEARXNG_DOCKER_ONELINER = "docker run -d -p 8080:8080 searxng/searxng";

function resolveBaseUrl(): string {
  return process.env["SEARXNG_HOST"] ?? SEARXNG_DEFAULT_HOST;
}

export const searxngRuntime: WebSearchRuntime = {
  id: "searxng",
  displayName: "SearXNG (self-hosted)",
  capabilityType: "web-search",
  residency: "local",
  requiresApiKey: false,

  async detect(ctx: TenantContext): Promise<boolean> {
    const baseUrl = resolveBaseUrl();
    let ok = false;
    try {
      await logPrivacyEvent(ctx, {
        eventType: "runtime.detect",
        actor: ctx.userId ?? ctx.tenantId,
        target: baseUrl,
        severity: "info",
        detail: "SearXNG probe (detect)",
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${baseUrl}/`, { signal: controller.signal });
      clearTimeout(timer);
      ok = res.status < 500;
    } catch {
      ok = false;
    }
    return ok;
  },

  async health(ctx: TenantContext): Promise<CapabilityHealth> {
    const baseUrl = resolveBaseUrl();
    let ok = false;
    try {
      await logPrivacyEvent(ctx, {
        eventType: "runtime.detect",
        actor: ctx.userId ?? ctx.tenantId,
        target: baseUrl,
        severity: "info",
        detail: "SearXNG probe (health)",
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${baseUrl}/`, { signal: controller.signal });
      clearTimeout(timer);
      ok = res.status < 500;
    } catch {
      ok = false;
    }
    return {
      status: ok ? "healthy" : "unreachable",
      detail: ok
        ? null
        : `Nothing listening at ${baseUrl}. Start SearXNG with: ${SEARXNG_DOCKER_ONELINER}`,
      detectedAt: new Date().toISOString(),
    };
  },

  async search(
    ctx: TenantContext,
    query: string,
    numResults: number,
  ): Promise<WebSearchResult[]> {
    const baseUrl = resolveBaseUrl();
    const url =
      `${baseUrl}/search` +
      `?format=json` +
      `&q=${encodeURIComponent(query)}` +
      `&categories=general` +
      `&language=en` +
      `&pageno=1`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await logPrivacyEvent(ctx, {
        eventType: "tool.web_search",
        actor: ctx.userId ?? ctx.tenantId,
        target: query,
        severity: "info",
        detail: `provider=searxng count=${numResults}`,
      });
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`SearXNG responded ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as {
        results?: Array<{ title: string; url: string; content?: string }>;
      };
      return (data.results ?? []).slice(0, numResults).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
      }));
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  },
};
