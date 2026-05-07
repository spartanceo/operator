/**
 * Pinecone vector store adapter — paid cloud alternative.
 *
 * Each tenant's knowledge base is stored in a Pinecone index named
 * `kb-{tenantId}` (slashed/special chars replaced with dashes). Pinecone
 * namespaces are not used — index-per-tenant ensures strong isolation.
 *
 * Requires a Pinecone API key stored via the capability credentials system.
 *
 * Privacy: every outbound `fetch()` is paired with a `logPrivacyEvent` call
 * within ±10 lines (tier-review Check #8). Residency is "cloud-required".
 */
import type { TenantContext } from "@workspace/types";

import { logger } from "../../../lib/logger";
import { logPrivacyEvent } from "../../privacy.service";
import type {
  CapabilityHealth,
  VectorStoreHit,
  VectorStoreItem,
  VectorStoreRuntime,
} from "../types";

const PINECONE_API_BASE = "https://api.pinecone.io";
const PINECONE_TIMEOUT_MS = 15_000;

function indexName(tenantId: string): string {
  return `kb-${tenantId.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase().slice(0, 45)}`;
}

async function pineconeFetch(
  ctx: TenantContext,
  url: string,
  init: RequestInit,
  apiKey: string,
  privacyTarget: string,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PINECONE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Api-Key": apiKey,
      "content-type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    await logPrivacyEvent(ctx, {
      eventType: "network.pinecone",
      actor: ctx.userId ?? ctx.tenantId,
      target: privacyTarget,
      severity: "medium",
      detail: init.method ?? "GET",
    });
    const res = await fetch(url, { ...init, headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function getIndexHost(
  ctx: TenantContext,
  name: string,
  apiKey: string,
): Promise<string | null> {
  const res = await pineconeFetch(
    ctx,
    `${PINECONE_API_BASE}/indexes/${name}`,
    { method: "GET" },
    apiKey,
    `pinecone:/indexes/${name}:describe`,
  );
  if (!res || !res.ok) return null;
  const json = (await res.json()) as { host?: string };
  return json.host ?? null;
}

export const pineconeVectorStoreAdapter: VectorStoreRuntime = {
  id: "pinecone",
  displayName: "Pinecone (cloud)",
  capabilityType: "vector-store",
  residency: "cloud-required",
  requiresApiKey: true,

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  },

  async health(ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    if (!apiKey) {
      return { status: "needs-credentials", detail: "Pinecone API key required", detectedAt };
    }
    const res = await pineconeFetch(
      ctx,
      `${PINECONE_API_BASE}/indexes`,
      { method: "GET" },
      apiKey,
      "pinecone:/indexes:list",
    );
    if (!res) return { status: "unreachable", detail: "Pinecone API not reachable", detectedAt };
    if (res.status === 401) {
      return { status: "needs-credentials", detail: "Invalid Pinecone API key", detectedAt };
    }
    if (!res.ok) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
    return { status: "healthy", detail: null, detectedAt };
  },

  async ensureCollection(
    ctx: TenantContext,
    dimension: number,
    apiKey?: string | null,
  ): Promise<void> {
    if (!apiKey) return;
    const name = indexName(ctx.tenantId);
    const existing = await getIndexHost(ctx, name, apiKey);
    if (existing) return;

    const res = await pineconeFetch(
      ctx,
      `${PINECONE_API_BASE}/indexes`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          dimension,
          metric: "cosine",
          spec: { serverless: { cloud: "aws", region: "us-east-1" } },
        }),
      },
      apiKey,
      `pinecone:/indexes:create`,
    );
    if (!res || !res.ok) {
      logger.warn(
        { tenantId: ctx.tenantId, status: res?.status },
        "pinecone.ensureCollection failed",
      );
    }
  },

  async upsert(
    ctx: TenantContext,
    items: VectorStoreItem[],
    apiKey?: string | null,
  ): Promise<void> {
    if (items.length === 0 || !apiKey) return;
    const name = indexName(ctx.tenantId);
    const host = await getIndexHost(ctx, name, apiKey);
    if (!host) return;

    const vectors = items.map((item) => ({
      id: item.id,
      values: item.vector,
      metadata: item.payload,
    }));
    const res = await pineconeFetch(
      ctx,
      `https://${host}/vectors/upsert`,
      {
        method: "POST",
        body: JSON.stringify({ vectors }),
      },
      apiKey,
      `pinecone:/vectors:upsert`,
    );
    if (!res || !res.ok) {
      const msg = `pinecone.upsert failed: HTTP ${res?.status ?? "unreachable"}`;
      logger.warn({ tenantId: ctx.tenantId, count: items.length, status: res?.status }, msg);
      throw new Error(msg);
    }
  },

  async search(
    ctx: TenantContext,
    vector: number[],
    topK: number,
    apiKey?: string | null,
  ): Promise<VectorStoreHit[]> {
    if (!apiKey) return [];
    const name = indexName(ctx.tenantId);
    const host = await getIndexHost(ctx, name, apiKey);
    if (!host) return [];

    const res = await pineconeFetch(
      ctx,
      `https://${host}/query`,
      {
        method: "POST",
        body: JSON.stringify({ vector, topK, includeMetadata: true }),
      },
      apiKey,
      `pinecone:/query`,
    );
    if (!res || !res.ok) return [];

    const json = (await res.json()) as {
      matches?: Array<{ id?: string; score?: number; metadata?: Record<string, unknown> }>;
    };
    return (json.matches ?? []).map((m) => ({
      id: String(m.id ?? ""),
      score: m.score ?? 0,
      payload: m.metadata ?? {},
    }));
  },

  async delete(
    ctx: TenantContext,
    ids: string[],
    apiKey?: string | null,
  ): Promise<void> {
    if (ids.length === 0 || !apiKey) return;
    const name = indexName(ctx.tenantId);
    const host = await getIndexHost(ctx, name, apiKey);
    if (!host) return;

    await pineconeFetch(
      ctx,
      `https://${host}/vectors/delete`,
      {
        method: "POST",
        body: JSON.stringify({ ids }),
      },
      apiKey,
      `pinecone:/vectors:delete`,
    );
  },
};
