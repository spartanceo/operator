/**
 * ChromaDB vector store adapter — manages collections and ANN search against a
 * locally-running ChromaDB instance (default: http://localhost:8000).
 *
 * REST API docs: https://docs.trychroma.com/reference/py-client
 * (the HTTP API mirrors the Python client methods)
 *
 * Each tenant's knowledge base is stored in a collection named
 * `kb_{tenantId}`. The `id` field on each item maps to the SQLite chunk id.
 *
 * Privacy: every outbound `fetch()` is paired with a `logPrivacyEvent` call
 * within ±10 lines (tier-review Check #8). ChromaDB runs locally.
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

const CHROMA_TIMEOUT_MS = 10_000;

function chromaHost(): string {
  return process.env["CHROMA_HOST"] ?? "http://127.0.0.1:8000";
}

function collectionName(tenantId: string): string {
  return `kb_${tenantId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function chromaFetch(
  ctx: TenantContext,
  path: string,
  init: RequestInit,
  privacyTarget: string,
): Promise<Response | null> {
  await logPrivacyEvent(ctx, {
    eventType: "network.chromadb",
    actor: ctx.userId ?? ctx.tenantId,
    target: privacyTarget,
    severity: "low",
    detail: init.method ?? "GET",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHROMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${chromaHost()}${path}`, {
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

async function getOrCreateCollection(
  ctx: TenantContext,
  name: string,
): Promise<string | null> {
  const res = await chromaFetch(
    ctx,
    `/api/v1/collections`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, get_or_create: true }),
    },
    `chromadb:/api/v1/collections:get_or_create`,
  );
  if (!res || !res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ?? null;
}

export const chromaDbVectorStoreAdapter: VectorStoreRuntime = {
  id: "chromadb",
  displayName: "ChromaDB (local)",
  capabilityType: "vector-store",
  residency: "local",
  requiresApiKey: false,

  async detect(ctx: TenantContext): Promise<boolean> {
    await logPrivacyEvent(ctx, {
      eventType: "runtime.detect",
      actor: ctx.userId ?? ctx.tenantId,
      target: "chromadb:detect",
      severity: "info",
      detail: "capability local probe",
    });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${chromaHost()}/api/v1/heartbeat`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res.status < 500;
    } catch {
      return false;
    }
  },

  async health(ctx: TenantContext): Promise<CapabilityHealth> {
    const detectedAt = new Date().toISOString();
    await logPrivacyEvent(ctx, {
      eventType: "runtime.detect",
      actor: ctx.userId ?? ctx.tenantId,
      target: "chromadb:health",
      severity: "info",
      detail: "capability health probe",
    });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${chromaHost()}/api/v1/heartbeat`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { status: "unreachable", detail: `HTTP ${res.status}`, detectedAt };
      return { status: "healthy", detail: null, detectedAt };
    } catch {
      return {
        status: "unreachable",
        detail: `ChromaDB not reachable at ${chromaHost()}`,
        detectedAt,
      };
    }
  },

  async ensureCollection(ctx: TenantContext, _dimension: number): Promise<void> {
    const name = collectionName(ctx.tenantId);
    const id = await getOrCreateCollection(ctx, name);
    if (!id) {
      const msg = "chromadb.ensureCollection: could not get/create collection";
      logger.warn({ tenantId: ctx.tenantId }, msg);
      throw new Error(msg);
    }
  },

  async upsert(ctx: TenantContext, items: VectorStoreItem[]): Promise<void> {
    if (items.length === 0) return;
    const name = collectionName(ctx.tenantId);
    const collId = await getOrCreateCollection(ctx, name);
    if (!collId) throw new Error("chromadb.upsert: could not resolve collection ID");

    const res = await chromaFetch(
      ctx,
      `/api/v1/collections/${collId}/upsert`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: items.map((i) => i.id),
          embeddings: items.map((i) => i.vector),
          metadatas: items.map((i) => i.payload),
        }),
      },
      `chromadb:/api/v1/collections/${collId}:upsert`,
    );
    if (!res || !res.ok) {
      const msg = `chromadb.upsert failed: HTTP ${res?.status ?? "unreachable"}`;
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
    const collId = await getOrCreateCollection(ctx, name);
    if (!collId) return [];

    const res = await chromaFetch(
      ctx,
      `/api/v1/collections/${collId}/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query_embeddings: [vector],
          n_results: topK,
          include: ["metadatas", "distances"],
        }),
      },
      `chromadb:/api/v1/collections/${collId}:query`,
    );
    if (!res || !res.ok) return [];

    const json = (await res.json()) as {
      ids?: string[][];
      distances?: number[][];
      metadatas?: Array<Array<Record<string, unknown>>>;
    };
    const ids = json.ids?.[0] ?? [];
    const distances = json.distances?.[0] ?? [];
    const metadatas = json.metadatas?.[0] ?? [];
    return ids.map((id, idx) => ({
      id,
      score: 1 - (distances[idx] ?? 0),
      payload: metadatas[idx] ?? {},
    }));
  },

  async delete(ctx: TenantContext, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const name = collectionName(ctx.tenantId);
    const collId = await getOrCreateCollection(ctx, name);
    if (!collId) return;

    await chromaFetch(
      ctx,
      `/api/v1/collections/${collId}/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      },
      `chromadb:/api/v1/collections/${collId}:delete`,
    );
  },
};
