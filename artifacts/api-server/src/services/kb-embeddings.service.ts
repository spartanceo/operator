/**
 * Knowledge Base Embeddings Bridge
 *
 * This module is the single integration point between the knowledge base
 * (kb.service) and the active capability backend pair:
 *
 *   Embeddings backend  — converts text to a float vector
 *   Vector store backend — stores / searches those vectors
 *
 * Resolution order:
 *   1. Look up the active backend id from `capability_settings`.
 *   2. Cast the backend to the concrete `EmbeddingsRuntime` or
 *      `VectorStoreRuntime` interface.
 *   3. If no backend is active, or the backend is not reachable, fall back
 *      to the SQLite-based local embedding (the deterministic FNV-1a hash
 *      bucket approach from kb.service) and note the fallback so callers
 *      can surface a notice to the user.
 *
 * The caller (kb.service / re-index service) always receives a valid embed
 * function and a flag indicating which path was taken. This keeps kb.service
 * free from capability-system imports while letting the capability layer stay
 * free from KB concerns.
 *
 * Privacy: credential lookups are read-only; no outbound network calls are
 * made in this module — those happen inside the adapter implementations, each
 * of which has its own logPrivacyEvent pairing.
 */
import { and, eq } from "drizzle-orm";

import {
  db,
  capabilitySettings,
  runtimeCredentials,
  tenantScope,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { decryptApiKey, keychainBridge } from "./runtime/credentials";
import { getCapabilityBackend } from "./capability/registry";
import type { EmbeddingsRuntime, VectorStoreRuntime } from "./capability/types";

// ─── Credential lookup ───────────────────────────────────────────────────────

async function loadCredential(
  ctx: TenantContext,
  backendId: string,
): Promise<string | null> {
  const kc = await keychainBridge();
  if (kc.available) {
    try {
      const kcKey = `${ctx.tenantId}:cap:${backendId}`;
      const v = await kc.get(kcKey);
      if (v) return v;
    } catch (e) {
      logger.warn({ err: e, backendId }, "keychain.get failed (kb-embeddings)");
    }
  }
  const credId = `cap:${backendId}`;
  const rows = await db
    .select()
    .from(runtimeCredentials)
    .where(
      and(
        tenantScope(ctx, runtimeCredentials),
        eq(runtimeCredentials.runtimeId, credId),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  try {
    return decryptApiKey({
      encryptedKey: rows[0].encryptedKey,
      iv: rows[0].iv,
      authTag: rows[0].authTag,
    });
  } catch (e) {
    logger.error({ err: e, backendId }, "Failed to decrypt kb-embeddings credential");
    return null;
  }
}

async function getActiveBackendId(
  ctx: TenantContext,
  capabilityType: "embeddings" | "vector-store",
): Promise<string | null> {
  const rows = await db
    .select()
    .from(capabilitySettings)
    .where(
      and(
        tenantScope(ctx, capabilitySettings),
        eq(capabilitySettings.capabilityType, capabilityType),
      ),
    )
    .limit(1);
  return rows[0]?.activeBackendId ?? null;
}

// ─── Public helpers ──────────────────────────────────────────────────────────

export interface ResolvedEmbedder {
  /** Produce a float vector for the given text. */
  embed(text: string): Promise<number[]>;
  /**
   * True when the resolved backend is the SQLite deterministic fallback.
   * Used by routes to surface a notice: "Using local fallback — configure
   * an embeddings backend for higher quality search."
   */
  isFallback: boolean;
  /** Id of the active backend, or "sqlite-fallback". */
  backendId: string;
}

export type ResolvedVectorStore =
  | { isFallback: true; backend: null; apiKey: null; backendId: string }
  | { isFallback: false; backend: VectorStoreRuntime; apiKey: string | null; backendId: string };

/**
 * Resolve the active embeddings backend for this tenant.
 *
 * Falls back to the local SQLite deterministic embedder (the FNV-1a hash
 * bucket from kb.service) if:
 *  - No embeddings backend is configured, or
 *  - The configured backend ID is not found in the registry.
 *
 * The `fallbackEmbedFn` parameter is the local embed() from kb.service;
 * passing it avoids a circular import.
 */
export async function resolveEmbedder(
  ctx: TenantContext,
  fallbackEmbedFn: (text: string) => number[],
): Promise<ResolvedEmbedder> {
  const activeId = await getActiveBackendId(ctx, "embeddings");
  if (!activeId) {
    return {
      embed: (text) => Promise.resolve(fallbackEmbedFn(text)),
      isFallback: true,
      backendId: "sqlite-fallback",
    };
  }

  const backend = getCapabilityBackend(activeId);
  if (!backend || backend.capabilityType !== "embeddings") {
    logger.warn({ tenantId: ctx.tenantId, activeId }, "kb-embeddings: unknown embeddings backend, using fallback");
    return {
      embed: (text) => Promise.resolve(fallbackEmbedFn(text)),
      isFallback: true,
      backendId: "sqlite-fallback",
    };
  }

  const embedRuntime = backend as EmbeddingsRuntime;
  const apiKey = backend.requiresApiKey
    ? await loadCredential(ctx, activeId)
    : null;

  return {
    embed: async (text) => {
      const vec = await embedRuntime.embed(ctx, text, apiKey);
      if (vec.length === 0) {
        // Backend is unreachable or missing credentials — fall back to local
        // deterministic embedder so we never store empty vectors in SQLite.
        logger.warn(
          { tenantId: ctx.tenantId, backendId: activeId },
          "kb-embeddings: backend returned empty vector, falling back to local embedder",
        );
        return fallbackEmbedFn(text);
      }
      return vec;
    },
    isFallback: false,
    backendId: activeId,
  };
}

/**
 * Resolve the active vector store backend for this tenant.
 *
 * Returns `isFallback: true` when no vector store is configured, signalling
 * the caller to use SQLite-based similarity search instead. Qdrant is the
 * preferred default — if it is configured and unreachable, we still return
 * it as the active backend (the adapter degrades gracefully to empty results
 * rather than throwing).
 */
export async function resolveVectorStore(
  ctx: TenantContext,
): Promise<ResolvedVectorStore> {
  const activeId = await getActiveBackendId(ctx, "vector-store");
  if (!activeId) {
    return { isFallback: true, backend: null, apiKey: null, backendId: "sqlite-fallback" };
  }

  const backend = getCapabilityBackend(activeId);
  if (!backend || backend.capabilityType !== "vector-store") {
    logger.warn({ tenantId: ctx.tenantId, activeId }, "kb-embeddings: unknown vector-store backend, using fallback");
    return { isFallback: true, backend: null, apiKey: null, backendId: "sqlite-fallback" };
  }

  const apiKey = backend.requiresApiKey
    ? await loadCredential(ctx, activeId)
    : null;

  return {
    isFallback: false,
    backend: backend as VectorStoreRuntime,
    apiKey,
    backendId: activeId,
  };
}

/**
 * Convenience: return both the embedder and vector store in one call,
 * since they are almost always needed together.
 */
export async function resolveKbBackends(
  ctx: TenantContext,
  fallbackEmbedFn: (text: string) => number[],
): Promise<{ embedder: ResolvedEmbedder; vectorStore: ResolvedVectorStore }> {
  const [embedder, vectorStore] = await Promise.all([
    resolveEmbedder(ctx, fallbackEmbedFn),
    resolveVectorStore(ctx),
  ]);
  return { embedder, vectorStore };
}
