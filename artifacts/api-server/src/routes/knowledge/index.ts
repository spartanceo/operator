/**
 * /api/knowledge — personal knowledge base / second brain.
 *
 * Routes:
 *  - GET    /collections                  list collections
 *  - POST   /collections                  create collection
 *  - DELETE /collections/:id              delete collection (unlinks documents)
 *  - GET    /documents                    list documents (optional collectionId)
 *  - POST   /documents/ingest             ingest text/url/youtube/file
 *  - GET    /documents/:id                fetch one document with body + chunks
 *  - DELETE /documents/:id                delete document + chunks
 *  - POST   /search                       hybrid semantic + keyword search
 *  - GET    /stats                        aggregate counts
 *  - GET    /export                       full snapshot
 *  - POST   /import                       restore from snapshot
 *
 * Validation lives in Zod here — the OpenAPI schema is the public contract,
 * but inbound bodies must be re-validated at the boundary (Standard 2).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  exportSnapshot,
  getDocument,
  importSnapshot,
  ingestDocument,
  KbValidationError,
  listCollections,
  listDocuments,
  search,
  stats,
} from "../../services/kb.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const CreateCollectionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  color: z.string().max(32).optional(),
});

const IngestSchema = z.object({
  sourceType: z.enum(["text", "url", "file", "youtube"]),
  title: z.string().min(1).max(500),
  body: z.string().max(2_000_000).optional(),
  url: z.string().url().max(2_048).optional(),
  mimeType: z.string().max(200).optional(),
  collectionId: z.string().min(1).max(120).optional(),
  tags: z.array(z.string().min(1).max(80)).max(20).optional(),
  allowDuplicate: z.boolean().optional(),
});

const SearchSchema = z.object({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(50).optional(),
  collectionId: z.string().min(1).max(120).optional(),
});

const ListDocumentsQuerySchema = PageSchema.extend({
  collectionId: z.string().min(1).max(120).optional(),
});

const ExportSnapshotSchema = z.object({
  exportedAt: z.string(),
  version: z.string(),
  collections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      documentCount: z.number().int().nonnegative(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  documents: z.array(
    z.object({
      id: z.string(),
      collectionId: z.string().nullable().optional(),
      title: z.string(),
      sourceType: z.string(),
      sourceUri: z.string().nullable().optional(),
      mimeType: z.string().nullable().optional(),
      body: z.string(),
      contentHash: z.string(),
      tags: z.array(z.string()),
      summary: z.string().nullable().optional(),
      createdAt: z.string(),
    }),
  ),
});

const ImportSchema = z.object({
  snapshot: ExportSnapshotSchema,
  replaceExisting: z.boolean().optional(),
});

function handleError(
  e: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  if (e instanceof KbValidationError) {
    res.status(400).json(err("VALIDATION", e.message));
    return;
  }
  next(e);
}

// ─── Collections ────────────────────────────────────────────────────────────

router.get("/collections", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listCollections(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/collections", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateCollectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid collection payload"));
      return;
    }
    const row = await createCollection(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/collections/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteCollection(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// ─── Documents ──────────────────────────────────────────────────────────────

router.get("/documents", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListDocumentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid documents query"));
      return;
    }
    const page = await listDocuments(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/documents/ingest", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = IngestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid ingest payload"));
      return;
    }
    const result = await ingestDocument(ctx, parsed.data);
    // Duplicate hits return 200 with `duplicate: true` so the UI can decide
    // whether to surface a "use existing" affordance — this is intentional
    // and documented in the OpenAPI spec.
    res.status(result.duplicate ? 409 : 200).json(ok(result));
  } catch (e) {
    handleError(e, res, next);
  }
});

router.get("/documents/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const detail = await getDocument(ctx, String(req.params.id));
    if (!detail) {
      res.status(404).json(err("NOT_FOUND", "Knowledge document not found"));
      return;
    }
    res.json(ok(detail));
  } catch (e) {
    next(e);
  }
});

router.delete("/documents/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteDocument(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// ─── Search & stats ─────────────────────────────────────────────────────────

router.post("/search", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SearchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid search payload"));
      return;
    }
    const hits = await search(ctx, parsed.data);
    res.json(ok({ query: parsed.data.query, hits }));
  } catch (e) {
    next(e);
  }
});

router.get("/stats", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await stats(ctx);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// ─── Export & import ────────────────────────────────────────────────────────

router.get("/export", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const snapshot = await exportSnapshot(ctx);
    res.json(ok(snapshot));
  } catch (e) {
    next(e);
  }
});

router.post("/import", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid import payload"));
      return;
    }
    const result = await importSnapshot(ctx, parsed.data.snapshot, {
      replaceExisting: parsed.data.replaceExisting ?? false,
    });
    res.json(ok(result));
  } catch (e) {
    handleError(e, res, next);
  }
});

export default router;
