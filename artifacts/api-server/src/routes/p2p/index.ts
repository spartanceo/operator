/**
 * /api/p2p — peer-to-peer model & skill distribution control plane.
 *
 * The desktop shell does the byte-shuffling (WebTorrent + IPFS); this
 * router is the tracker / signing-verification surface it talks to.
 *
 *   GET    /p2p/network                       — settings + swarms + totals
 *   GET    /p2p/relays                        — privacy-relay node list
 *   GET    /p2p/keys                          — pinned publisher keys (read-only;
 *                                                 keys are loaded offline via
 *                                                 OMNINITY_P2P_PINNED_KEYS)
 *   GET    /p2p/content                       — list signed manifests
 *   GET    /p2p/content/:id                   — fetch one signed manifest
 *   POST   /p2p/content                       — publisher upload (verified)
 *   POST   /p2p/content/:id/verify            — confirm download integrity
 *   POST   /p2p/swarms/:id/announce           — desktop reports peer count
 *   GET    /p2p/swarms                        — list per-tenant swarms
 *   GET    /p2p/settings                      — seeding/relay settings
 *   PUT    /p2p/settings                      — update seeding settings
 *   GET    /p2p/fallback/:id                  — should we use CDN fallback?
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  ContentRejectedError,
  announceSwarm,
  getContent,
  getNetworkOverview,
  getSeedingSettings,
  getSwarm,
  listContent,
  listPublisherKeys,
  listRelays,
  listSwarms,
  publishContent,
  shouldFallbackToCdn,
  updateSeedingSettings,
  verifyDownloadedContent,
} from "../../services/p2p.service";

const router: IRouter = Router();

const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/, "sha256 must be 64 hex chars");
const ContentIdSchema = z.string().min(3).max(256);

const ManifestSchema = z.object({
  contentId: ContentIdSchema,
  contentType: z.enum(["model", "skill"]),
  version: z.string().min(1).max(64),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024 * 1024),
  sha256: Sha256Schema,
  magnetUri: z.string().min(1).max(2048).startsWith("magnet:"),
  ipfsCid: z.string().min(3).max(256),
  fallbackUrl: z.string().url().nullable(),
  publisherKeyId: z.string().min(1).max(128),
  publishedAt: z.string().datetime(),
});

const SignedManifestSchema = z.object({
  manifest: ManifestSchema,
  signature: z.string().min(8).max(2048),
});

const AnnounceSchema = z.object({
  peerCount: z.number().int().min(0).max(1_000_000),
  uploadBytes: z.number().int().min(0).optional(),
  downloadBytes: z.number().int().min(0).optional(),
});

const SettingsSchema = z.object({
  seedingEnabled: z.boolean().optional(),
  uploadCapMbps: z.number().positive().nullable().optional(),
  useRelay: z.boolean().optional(),
  fallbackToCdn: z.boolean().optional(),
  peerFloor: z.number().int().min(1).max(100).optional(),
});

const VerifySchema = z.object({
  sha256: Sha256Schema,
});

const ListContentQuery = z.object({
  contentType: z.enum(["model", "skill"]).optional(),
});

router.get("/network", requireTenant(), (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(getNetworkOverview(ctx.tenantId)));
  } catch (e) {
    next(e);
  }
});

router.get("/relays", requireTenant(), (_req, res, next) => {
  try {
    res.json(ok({ relays: listRelays() }));
  } catch (e) {
    next(e);
  }
});

router.get("/keys", requireTenant(), (_req, res, next) => {
  try {
    res.json(ok({ keys: listPublisherKeys() }));
  } catch (e) {
    next(e);
  }
});

router.get("/content", requireTenant(), (req, res, next) => {
  try {
    const parsed = ListContentQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid contentType filter"));
      return;
    }
    const items = listContent({ contentType: parsed.data.contentType });
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.get("/content/:id", requireTenant(), (req, res, next) => {
  try {
    const id = String(req.params["id"] ?? "");
    if (!ContentIdSchema.safeParse(id).success) {
      res.status(400).json(err("VALIDATION", "Invalid content id"));
      return;
    }
    const found = getContent(id);
    if (!found) {
      res.status(404).json(err("NOT_FOUND", "Unknown content id"));
      return;
    }
    res.json(ok(found));
  } catch (e) {
    next(e);
  }
});

router.post("/content", requireTenant(), (req, res, next) => {
  try {
    const parsed = SignedManifestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid signed manifest payload"));
      return;
    }
    try {
      const signed = publishContent(parsed.data);
      res.status(201).json(ok(signed));
    } catch (e) {
      if (e instanceof ContentRejectedError) {
        res.status(400).json(err("SIGNATURE_REJECTED", e.message, { reason: e.reason }));
        return;
      }
      next(e);
    }
  } catch (e) {
    next(e);
  }
});

router.post("/content/:id/verify", requireTenant(), (req, res, next) => {
  try {
    const id = String(req.params["id"] ?? "");
    if (!ContentIdSchema.safeParse(id).success) {
      res.status(400).json(err("VALIDATION", "Invalid content id"));
      return;
    }
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid verify payload"));
      return;
    }
    const result = verifyDownloadedContent(id, parsed.data.sha256);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/swarms/:id/announce", requireTenant(), (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    if (!ContentIdSchema.safeParse(id).success) {
      res.status(400).json(err("VALIDATION", "Invalid content id"));
      return;
    }
    const parsed = AnnounceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid announce payload"));
      return;
    }
    try {
      const stats = announceSwarm(ctx.tenantId, { contentId: id, ...parsed.data });
      res.json(ok(stats));
    } catch (e) {
      if (e instanceof ContentRejectedError) {
        res.status(400).json(err("ANNOUNCE_REJECTED", e.message, { reason: e.reason }));
        return;
      }
      next(e);
    }
  } catch (e) {
    next(e);
  }
});

router.get("/swarms", requireTenant(), (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok({ swarms: listSwarms(ctx.tenantId) }));
  } catch (e) {
    next(e);
  }
});

router.get("/swarms/:id", requireTenant(), (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    const found = getSwarm(ctx.tenantId, id);
    if (!found) {
      res.status(404).json(err("NOT_FOUND", "No swarm data for content"));
      return;
    }
    res.json(ok(found));
  } catch (e) {
    next(e);
  }
});

router.get("/settings", requireTenant(), (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(getSeedingSettings(ctx.tenantId)));
  } catch (e) {
    next(e);
  }
});

router.put("/settings", requireTenant(), (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid settings payload"));
      return;
    }
    try {
      const next = updateSeedingSettings(ctx.tenantId, parsed.data);
      res.json(ok(next));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid settings";
      res.status(400).json(err("VALIDATION", msg));
    }
  } catch (e) {
    next(e);
  }
});

router.get("/fallback/:id", requireTenant(), (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const id = String(req.params["id"] ?? "");
    if (!ContentIdSchema.safeParse(id).success) {
      res.status(400).json(err("VALIDATION", "Invalid content id"));
      return;
    }
    if (!getContent(id)) {
      res.status(404).json(err("NOT_FOUND", "Unknown content id"));
      return;
    }
    res.json(ok({ contentId: id, useFallback: shouldFallbackToCdn(ctx.tenantId, id) }));
  } catch (e) {
    next(e);
  }
});

export default router;
