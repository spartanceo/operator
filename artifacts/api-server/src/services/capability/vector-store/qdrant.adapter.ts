/**
 * Qdrant vector store adapter — manages collections and ANN search against a
 * locally-running Qdrant instance (default: http://localhost:6333).
 *
 * REST API docs: https://qdrant.tech/documentation/interfaces/rest/
 *
 * Each tenant's knowledge base chunks are stored in a collection named
 * `kb_{tenantId}`. The `id` field on each item maps to the SQLite chunk id
 * so results can be correlated back to full text rows without duplicating data.
 *
 * Privacy: every outbound `fetch()` is paired with a `logPrivacyEvent` call
 * within ±10 lines (tier-review Check #8). Qdrant runs locally — residency is
 * "local" and no user data leaves the machine.
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

const QDRANT_TIMEOUT_MS = 10_000;

function qdrantHost(): string {
  return process.env["QDRANT_HOST"] ?? "http://127.0.0.1:6333";
}

function collectionName(tenantId: string): string {
  return `kb_${tenantId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function qdrantFetch(
  ctx: TenantContext,
  path: string,
  init: RequestInit,
  privacyTarget: string,
): Promise<Response | null> {
  await logPrivacyEvent(ctx, {
    eventType: "network.qdrant",
    actor: ctx.userId ?? ctx.tenantId,
    target: privacyTarget,
    severity: "low",
    detail: init.method ?? "GET",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QDRANT_TIMEOUT_MS);
  try {
    const res = await fetch(`${qdrantHost()}${path}`, {
      ...init,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export const qdrantVectorStoreAdapter: VectorStoreRuntime = {
  id: "qdrant",
  displayName: "Qdrant (local)",
  capabilityType: "vector-store",
  residency: "local",
  requiresApiKey: false,

  async detect(ctx: TenantContext): Promise<boolean> {
    const res = await qdrantFetch(ctx, "/", { method: "GET" }, "qdrant:detect");
    return Boolean(res && res.status < 500);
  },

  async health(ctx: TenantContext): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    const res = await qdrantFetch(ctx, "/healthz", { method: "GET" }, "qdrant:health");
    if (!res) {
      return {
        status: "unreachable",
        detail: `Qdrant not reachable at ${qdrantHost()}`,
        detectedAt,
      };
    }
    if (!res.ok) {
      return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
    }
    return { status: "healthy", detail: null, detectedAt };
  },

  async ensureCollection(ctx: TenantContext, dimension: number): Promise<void> {
    const name = collectionName(ctx.tenantId);
    const checkRes = await qdrantFetch(
      ctx,
      `/collections/${name}`,
      { method: "GET" },
      `qdrant:/collections/${name}:check`,
    );
    if (checkRes && checkRes.status === 200) return;
    const createRes = await qdrantFetch(
      ctx,
      `/collections/${name}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vectors: { size: dimension, distance: "Cosine" },
        }),
      },
      `qdrant:/collections/${name}:create`,
    );
    if (!createRes || !createRes.ok) {
      const msg = `qdrant.ensureCollection failed: HTTP ${createRes?.status ?? "unreachable"}`;
      logger.error({ tenantId: ctx.tenantId, status: createRes?.status }, msg);
      throw new Error(msg);
    }
  },

  async upsert(ctx: TenantContext, items: VectorStoreItem[]): Promise<void> {
    if (items.length === 0) return;
    const name = collectionName(ctx.tenantId);
    const points = items.map((item) => ({
      id: item.id,
      vector: item.vector,
      payload: item.payload,
    }));
    const res = await qdrantFetch(
      ctx,
      `/collections/${name}/points`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ points }),
      },
      `qdrant:/collections/${name}/points:upsert`,
    );
    if (!res || !res.ok) {
      const msg = `qdrant.upsert failed: HTTP ${res?.status ?? "unreachable"}`;
      logger.warn({ tenantId: ctx.tenantId, count: items.length, status: res?.status }, msg);
      throw new Error(msg);
    }
  },

  async search(
    ctx: TenantContext,
    vector: number[],
    topK: number,
  ): Promise<VectorStoreHit[]> {
    const name = collectionName(ctx.tenantId);
    const res = await qdrantFetch(
      ctx,
      `/collections/${name}/points/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vector, limit: topK, with_payload: true }),
      },
      `qdrant:/collections/${name}/points:search`,
    );
    if (!res || !res.ok) return [];
    const json = (await res.json()) as {
      result?: Array<{ id?: string; score?: number; payload?: Record<string, unknown> }>;
    };
    return (json.result ?? []).map((r) => ({
      id: String(r.id ?? ""),
      score: r.score ?? 0,
      payload: r.payload ?? {},
    }));
  },

  async delete(ctx: TenantContext, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const name = collectionName(ctx.tenantId);
    await qdrantFetch(
      ctx,
      `/collections/${name}/points/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ points: ids }),
      },
      `qdrant:/collections/${name}/points:delete`,
    );
  },
};
