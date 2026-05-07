/**
 * Knowledge Base Re-index Service
 *
 * When the user switches the active embeddings backend or vector store backend,
 * existing chunk embeddings (stored as JSON in SQLite) may no longer match the
 * new backend's embedding space. This service re-embeds every chunk for the
 * tenant using the currently-active embeddings backend and, if a vector store
 * backend is active, pushes each chunk's vector there too.
 *
 * Design decisions:
 *  - Re-indexing runs synchronously and reports progress via an async generator
 *    so the route layer can stream SSE progress to the UI without polling.
 *  - A single re-index job per tenant is allowed at a time; concurrent calls
 *    are rejected with a 409 so the UI can show "already running".
 *  - On failure the partially-updated embeddings are left in place (they are
 *    still valid SQLite embeddings that the fallback path can use).
 *  - Privacy: every outbound call inside the adapters is already logged; this
 *    module only adds a single top-level logPrivacyEvent for the job itself.
 *
 * tier-review: the activeJobs Map is bounded by active-tenant concurrency —
 * each entry is removed when the job completes or fails. At steady state the
 * Map size equals the number of tenants currently re-indexing (expected ≤ 1).
 */
import { and, eq } from "drizzle-orm";

import {
  db,
  kbChunks,
  kbDocuments,
  tenantScope,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";
import { embedLocal } from "../lib/kb-embed-local";
import { resolveKbBackends } from "./kb-embeddings.service";
import type { VectorStoreItem } from "./capability/types";

// ─── In-progress guard ───────────────────────────────────────────────────────

// tier-review: bounded — one entry per actively re-indexing tenant, removed on completion
const activeJobs = new Map<string, true>();

export function isReindexRunning(tenantId: string): boolean {
  return activeJobs.has(tenantId);
}

// ─── Progress events ─────────────────────────────────────────────────────────

export interface ReindexProgress {
  phase: "scanning" | "embedding" | "upserting" | "done" | "degraded" | "error";
  totalChunks: number;
  processedChunks: number;
  message: string;
}

// ─── Re-index job ─────────────────────────────────────────────────────────────

const VECTOR_STORE_BATCH = 50;
const EMBED_DIM_NOMIC = 768;
const EMBED_DIM_OPENAI = 1536;
const EMBED_DIM_DEFAULT = 256;

function inferDimension(backendId: string): number {
  if (backendId === "ollama-embed") return EMBED_DIM_NOMIC;
  if (backendId === "openai-embed") return EMBED_DIM_OPENAI;
  return EMBED_DIM_DEFAULT;
}

/**
 * Re-embed and optionally re-upsert all chunks for a tenant.
 *
 * Yields progress events as chunks are processed. The caller should stream
 * these to the UI via SSE. When the generator completes, the job is finished.
 */
export async function* reindexKnowledgeBase(
  ctx: TenantContext,
): AsyncGenerator<ReindexProgress> {
  if (activeJobs.has(ctx.tenantId)) {
    yield {
      phase: "error",
      totalChunks: 0,
      processedChunks: 0,
      message: "A re-index job is already running for this tenant",
    };
    return;
  }

  activeJobs.set(ctx.tenantId, true);
  await logPrivacyEvent(ctx, {
    eventType: "knowledge.reindex_start",
    actor: ctx.userId ?? ctx.tenantId,
    target: "kb:all",
    severity: "low",
    detail: "embeddings backend switch triggered re-index",
  });

  try {
    yield {
      phase: "scanning",
      totalChunks: 0,
      processedChunks: 0,
      message: "Scanning knowledge base chunks…",
    };

    const chunks = await db
      .select()
      .from(kbChunks)
      .where(tenantScope(ctx, kbChunks));

    const totalChunks = chunks.length;
    if (totalChunks === 0) {
      yield {
        phase: "done",
        totalChunks: 0,
        processedChunks: 0,
        message: "Knowledge base is empty — nothing to re-index.",
      };
      return;
    }

    yield {
      phase: "embedding",
      totalChunks,
      processedChunks: 0,
      message: `Re-embedding ${totalChunks} chunks…`,
    };

    const { embedder, vectorStore } = await resolveKbBackends(ctx, embedLocal);
    const embeddingDimension = inferDimension(embedder.backendId);

    // Ensure the vector store collection exists with the right dimension.
    // Failures are tracked and surfaced in the final progress event.
    let vectorStoreErrors = 0;
    if (!vectorStore.isFallback) {
      try {
        await vectorStore.backend.ensureCollection(
          ctx,
          embeddingDimension,
          vectorStore.apiKey,
        );
      } catch (err) {
        vectorStoreErrors++;
        logger.warn({ err, tenantId: ctx.tenantId }, "kb.reindex: ensureCollection failed");
      }
    }

    let processed = 0;
    let upsertBatch: VectorStoreItem[] = [];

    for (const chunk of chunks) {
      const vector = await embedder.embed(chunk.text);

      // Update the JSON embedding in SQLite (used by the local cosine fallback).
      await db
        .update(kbChunks)
        .set({ embedding: JSON.stringify(vector), updatedAt: Date.now() })
        .where(
          and(
            tenantScope(ctx, kbChunks),
            eq(kbChunks.id, chunk.id),
          ),
        );

      processed++;

      if (!vectorStore.isFallback) {
        upsertBatch.push({
          id: chunk.id,
          vector,
          payload: {
            chunkId: chunk.id,
            documentId: chunk.documentId,
            position: chunk.position,
          },
        });

        if (upsertBatch.length >= VECTOR_STORE_BATCH) {
          yield {
            phase: "upserting",
            totalChunks,
            processedChunks: processed,
            message: `Uploading batch to ${vectorStore.backendId}…`,
          };
          try {
            await vectorStore.backend.upsert(ctx, upsertBatch, vectorStore.apiKey);
          } catch (err) {
            vectorStoreErrors++;
            logger.warn({ err, tenantId: ctx.tenantId, count: upsertBatch.length }, "kb.reindex: upsert batch failed");
          }
          upsertBatch = [];
        }
      }

      if (processed % 10 === 0 || processed === totalChunks) {
        yield {
          phase: vectorStore.isFallback ? "embedding" : "upserting",
          totalChunks,
          processedChunks: processed,
          message: vectorStore.isFallback
            ? `Re-embedded ${processed}/${totalChunks} chunks (SQLite storage)`
            : `Re-embedded ${processed}/${totalChunks} chunks → ${vectorStore.backendId}`,
        };
      }
    }

    // Flush any remaining items in the upsert batch.
    if (!vectorStore.isFallback && upsertBatch.length > 0) {
      try {
        await vectorStore.backend.upsert(ctx, upsertBatch, vectorStore.apiKey);
      } catch (err) {
        vectorStoreErrors++;
        logger.warn({ err, tenantId: ctx.tenantId, count: upsertBatch.length }, "kb.reindex: final upsert batch failed");
      }
    }

    await logPrivacyEvent(ctx, {
      eventType: "knowledge.reindex_done",
      actor: ctx.userId ?? ctx.tenantId,
      target: "kb:all",
      severity: "low",
      detail: `totalChunks=${totalChunks} embeddingsBackend=${embedder.backendId} vectorStore=${vectorStore.backendId} vectorStoreErrors=${vectorStoreErrors}`,
    });

    logger.info(
      { tenantId: ctx.tenantId, totalChunks, embeddingsBackend: embedder.backendId, vectorStore: vectorStore.backendId, vectorStoreErrors },
      "kb.reindex complete",
    );

    if (!vectorStore.isFallback && vectorStoreErrors > 0) {
      yield {
        phase: "degraded",
        totalChunks,
        processedChunks: totalChunks,
        message: `SQLite embeddings updated, but ${vectorStoreErrors} batch(es) failed to write to ${vectorStore.backendId}. Ensure the service is running and re-index to complete.`,
      };
    } else {
      const notice = vectorStore.isFallback
        ? " (SQLite vector search active — configure a vector store for better performance)"
        : "";
      yield {
        phase: "done",
        totalChunks,
        processedChunks: totalChunks,
        message: `Re-indexed ${totalChunks} chunk(s) successfully${notice}.`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ tenantId: ctx.tenantId, err: message }, "kb.reindex error");
    yield {
      phase: "error",
      totalChunks: 0,
      processedChunks: 0,
      message: `Re-index failed: ${message}`,
    };
  } finally {
    activeJobs.delete(ctx.tenantId);
  }
}

/**
 * Upsert a single newly-ingested chunk into the active vector store backend.
 * Called by kb.service after inserting a new document so fresh ingests are
 * immediately searchable via the vector store without a full re-index.
 *
 * Falls back silently if no vector store is configured.
 */
export async function upsertChunkToVectorStore(
  ctx: TenantContext,
  chunkId: string,
  vector: number[],
  documentId: string,
  position: number,
): Promise<void> {
  const { isFallback, backend, apiKey } = await resolveVectorStoreQuiet(ctx);
  if (isFallback) return;
  try {
    await backend.upsert(
      ctx,
      [{ id: chunkId, vector, payload: { chunkId, documentId, position } }],
      apiKey,
    );
  } catch (err) {
    logger.warn({ err, chunkId, tenantId: ctx.tenantId }, "upsertChunkToVectorStore failed (non-fatal)");
  }
}

/**
 * Delete chunk vectors from the active vector store backend when a document
 * is deleted from the KB. Falls back silently.
 */
export async function deleteChunksFromVectorStore(
  ctx: TenantContext,
  chunkIds: string[],
): Promise<void> {
  if (chunkIds.length === 0) return;
  const { isFallback, backend, apiKey } = await resolveVectorStoreQuiet(ctx);
  if (isFallback) return;
  try {
    await backend.delete(ctx, chunkIds, apiKey);
  } catch (err) {
    logger.warn({ err, tenantId: ctx.tenantId }, "deleteChunksFromVectorStore failed (non-fatal)");
  }
}

// ─── Private helper ──────────────────────────────────────────────────────────

async function resolveVectorStoreQuiet(ctx: TenantContext) {
  try {
    const { resolveVectorStore } = await import("./kb-embeddings.service");
    return resolveVectorStore(ctx);
  } catch {
    return { isFallback: true as const, backend: null, apiKey: null, backendId: "sqlite-fallback" };
  }
}

