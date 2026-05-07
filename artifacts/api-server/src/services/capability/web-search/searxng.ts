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

/**
 * Docker one-liner that mounts an inline settings file with JSON format
 * enabled. SearXNG disables the JSON output format by default; without this
 * the search endpoint returns 403 even though the UI is reachable.
 */
export const SEARXNG_DOCKER_JSON_ONELINER =
  `docker run -d -p 8080:8080 ` +
  `-e SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml ` +
  `--mount 'type=tmpfs,destination=/etc/searxng' ` +
  `--entrypoint sh searxng/searxng -c ` +
  `"echo 'search:\\n  formats: [html, json]' > /etc/searxng/settings.yml && /usr/local/searxng/dockerfiles/docker-entrypoint.sh"`;

function resolveBaseUrl(): string {
  return process.env["SEARXNG_HOST"] ?? SEARXNG_DEFAULT_HOST;
}

/**
 * Probe the JSON search endpoint with a short dummy query.
 * Returns "reachable" when SearXNG is up but JSON is disabled (HTTP 403),
 * "json-enabled" when the JSON API is fully functional, and "unreachable"
 * when nothing is listening.
 */
async function probeJsonEndpoint(
  baseUrl: string,
): Promise<"json-enabled" | "reachable" | "unreachable"> {
  const url = `${baseUrl}/search?format=json&q=test&pageno=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 403 || res.status === 400) {
      // SearXNG is running but has JSON format disabled (returns 403).
      return "reachable";
    }
    if (res.ok) {
      // Verify the response is actually JSON (not an HTML error page).
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) return "json-enabled";
      return "reachable";
    }
    // Other non-ok status — still reachable but something is wrong.
    return "reachable";
  } catch {
    clearTimeout(timer);
    return "unreachable";
  }
}

export const searxngRuntime: WebSearchRuntime = {
  id: "searxng",
  displayName: "SearXNG (self-hosted)",
  capabilityType: "web-search",
  residency: "local",
  requiresApiKey: false,

  async detect(ctx: TenantContext): Promise<boolean> {
    const baseUrl = resolveBaseUrl();
    await logPrivacyEvent(ctx, {
      eventType: "runtime.detect",
      actor: ctx.userId ?? ctx.tenantId,
      target: baseUrl,
      severity: "info",
      detail: "SearXNG probe (detect)",
    });
    const status = await probeJsonEndpoint(baseUrl);
    // Only report "detected" when JSON is fully enabled — otherwise the
    // search tool will fail at runtime even though the UI is reachable.
    return status === "json-enabled";
  },

  async health(ctx: TenantContext): Promise<CapabilityHealth> {
    const baseUrl = resolveBaseUrl();
    await logPrivacyEvent(ctx, {
      eventType: "runtime.detect",
      actor: ctx.userId ?? ctx.tenantId,
      target: baseUrl,
      severity: "info",
      detail: "SearXNG probe (health)",
    });
    const status = await probeJsonEndpoint(baseUrl);
    if (status === "json-enabled") {
      return { status: "healthy", detail: null, detectedAt: new Date().toISOString() };
    }
    if (status === "reachable") {
      return {
        status: "needs-credentials",
        detail:
          `SearXNG is running at ${baseUrl} but JSON format is disabled. ` +
          `Add 'formats: [html, json]' under the 'search:' key in your SearXNG settings.yml, ` +
          `then restart the container. Quick start with JSON enabled:\n${SEARXNG_DOCKER_JSON_ONELINER}`,
        detectedAt: new Date().toISOString(),
      };
    }
    return {
      status: "unreachable",
      detail:
        `Nothing listening at ${baseUrl}. Start SearXNG with:\n${SEARXNG_DOCKER_ONELINER}`,
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
