/**
 * Weaviate Cloud vector store adapter — paid cloud alternative (Weaviate Cloud
 * Services / WCS). Communicates via the Weaviate REST v1 API.
 *
 * Each tenant gets a Weaviate class named `Kb{sanitisedTenantId}`. Classes
 * are created on first use. Requires:
 *   - WEAVIATE_HOST env var (e.g. `https://my-cluster.weaviate.network`)
 *   - API key credential stored via the capability credentials system.
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

const WEAVIATE_TIMEOUT_MS = 15_000;

function weaviateHost(): string {
  return process.env["WEAVIATE_HOST"] ?? "";
}

/** Weaviate class names must start with uppercase and be alphanumeric. */
function className(tenantId: string): string {
  const safe = tenantId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  return `Kb${safe.charAt(0).toUpperCase()}${safe.slice(1)}`;
}

async function weaviateFetch(
  ctx: TenantContext,
  path: string,
  init: RequestInit,
  apiKey: string,
  privacyTarget: string,
): Promise<Response | null> {
  const host = weaviateHost();
  if (!host) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEAVIATE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    await logPrivacyEvent(ctx, {
      eventType: "network.weaviate",
      actor: ctx.userId ?? ctx.tenantId,
      target: privacyTarget,
      severity: "medium",
      detail: init.method ?? "GET",
    });
    const res = await fetch(`${host}${path}`, { ...init, headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export const weaviateVectorStoreAdapter: VectorStoreRuntime = {
  id: "weaviate-cloud",
  displayName: "Weaviate Cloud (paid)",
  capabilityType: "vector-store",
  residency: "cloud-required",
  requiresApiKey: true,

  async detect(_ctx: TenantContext): Promise<boolean> {
    return false;
  },

  async health(ctx: TenantContext, apiKey?: string | null): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    if (!apiKey) {
      return { status: "needs-credentials", detail: "Weaviate API key required", detectedAt };
    }
    if (!weaviateHost()) {
      return {
        status: "needs-credentials",
        detail: "WEAVIATE_HOST environment variable not set",
        detectedAt,
      };
    }
    const res = await weaviateFetch(
      ctx,
      "/v1/meta",
      { method: "GET" },
      apiKey,
      "weaviate:/v1/meta:health",
    );
    if (!res) return { status: "unreachable", detail: "Weaviate not reachable", detectedAt };
    if (res.status === 401 || res.status === 403) {
      return { status: "needs-credentials", detail: "Invalid Weaviate API key", detectedAt };
    }
    if (!res.ok) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
    return { status: "healthy", detail: null, detectedAt };
  },

  async ensureCollection(
    ctx: TenantContext,
    _dimension: number,
    apiKey?: string | null,
  ): Promise<void> {
    if (!apiKey) return;
    const cls = className(ctx.tenantId);
    const check = await weaviateFetch(
      ctx,
      `/v1/schema/${cls}`,
      { method: "GET" },
      apiKey,
      `weaviate:/v1/schema/${cls}:check`,
    );
    if (check && check.status === 200) return;
    const res = await weaviateFetch(
      ctx,
      "/v1/schema",
      {
        method: "POST",
        body: JSON.stringify({
          class: cls,
          vectorizer: "none",
          properties: [
            { name: "chunkId", dataType: ["text"] },
            { name: "documentId", dataType: ["text"] },
            { name: "position", dataType: ["int"] },
          ],
        }),
      },
      apiKey,
      `weaviate:/v1/schema:create`,
    );
    if (!res || !res.ok) {
      const msg = `weaviate.ensureCollection failed: HTTP ${res?.status ?? "unreachable"}`;
      logger.warn({ tenantId: ctx.tenantId, status: res?.status }, msg);
      throw new Error(msg);
    }
  },

  async upsert(
    ctx: TenantContext,
    items: VectorStoreItem[],
    apiKey?: string | null,
  ): Promise<void> {
    if (items.length === 0 || !apiKey) return;
    const cls = className(ctx.tenantId);
    const objects = items.map((item) => ({
      class: cls,
      id: item.id,
      vector: item.vector,
      properties: item.payload,
    }));
    const res = await weaviateFetch(
      ctx,
      "/v1/batch/objects",
      {
        method: "POST",
        body: JSON.stringify({ objects }),
      },
      apiKey,
      `weaviate:/v1/batch/objects:upsert`,
    );
    if (!res || !res.ok) {
      const msg = `weaviate.upsert failed: HTTP ${res?.status ?? "unreachable"}`;
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
    const cls = className(ctx.tenantId);
    const query = `{
      Get {
        ${cls}(nearVector: { vector: ${JSON.stringify(vector)} }, limit: ${topK}) {
          _additional { id certainty }
          chunkId
          documentId
          position
        }
      }
    }`;
    const res = await weaviateFetch(
      ctx,
      "/v1/graphql",
      {
        method: "POST",
        body: JSON.stringify({ query }),
      },
      apiKey,
      `weaviate:/v1/graphql:nearVector`,
    );
    if (!res || !res.ok) return [];
    const json = (await res.json()) as {
      data?: {
        Get?: Record<string, Array<{
          _additional?: { id?: string; certainty?: number };
          chunkId?: string;
          documentId?: string;
          position?: number;
        }>>;
      };
    };
    const rows = json.data?.Get?.[cls] ?? [];
    return rows.map((r) => ({
      id: r._additional?.id ?? r.chunkId ?? "",
      score: r._additional?.certainty ?? 0,
      payload: {
        chunkId: r.chunkId,
        documentId: r.documentId,
        position: r.position,
      },
    }));
  },

  async delete(
    ctx: TenantContext,
    ids: string[],
    apiKey?: string | null,
  ): Promise<void> {
    if (ids.length === 0 || !apiKey) return;
    const cls = className(ctx.tenantId);
    await Promise.all(
      ids.map((id) =>
        weaviateFetch(
          ctx,
          `/v1/objects/${cls}/${id}`,
          { method: "DELETE" },
          apiKey,
          `weaviate:/v1/objects/${cls}/${id}:delete`,
        ),
      ),
    );
  },
};
