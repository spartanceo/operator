/**
 * /api/store — Hosted Skill Store endpoints.
 *
 * Browses published skills, manages creator accounts, and installs
 * a store skill into the local SQLite. Every endpoint is guarded by
 * the consent-based privacy gate inside `store.service.ts`.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  CreatorAuthError,
  CreatorNotFoundError,
  StoreNetworkDisabledError,
  StoreSkillNotFoundError,
  StoreValidationError,
  checkUpdates,
  getCreatorByHandle,
  getCreatorDashboard,
  getStoreSkill,
  installStoreSkill,
  listCreators,
  listStoreSkills,
  listVersions,
  publishDraft,
  signupCreator,
} from "../../services/store.service";
import { DraftNotFoundError, DraftValidationError } from "../../services/skill-draft.service";

const router: IRouter = Router();

const ExternalLinkSchema = z.object({
  label: z.string().min(1).max(80),
  url: z.string().url().max(500),
});

const CreatorSignupSchema = z.object({
  handle: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "handle must be lowercase letters, numbers, or hyphens")
    .optional(),
  displayName: z.string().min(2).max(120),
  bio: z.string().max(2_000).optional(),
  websiteUrl: z.string().url().max(500).optional(),
  externalLinks: z.array(ExternalLinkSchema).max(10).optional(),
});

const PublishSchema = z.object({
  draftId: z.string().min(1).max(120),
  apiToken: z.string().min(1).max(200),
  documentation: z.string().max(8_000).optional(),
});

const ListSkillsSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  category: z.string().min(1).max(80).optional(),
  creatorHandle: z.string().min(1).max(80).optional(),
  search: z.string().min(1).max(200).optional(),
});

const SkillKeySchema = z.object({
  creatorHandle: z.string().min(1).max(80),
  slug: z.string().min(1).max(80),
});

const DashboardSchema = z.object({
  apiToken: z.string().min(1).max(200),
});

function handleStoreError(e: unknown, res: import("express").Response): boolean {
  if (e instanceof StoreNetworkDisabledError) {
    res.status(403).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof CreatorAuthError) {
    res.status(401).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof CreatorNotFoundError || e instanceof StoreSkillNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  if (
    e instanceof StoreValidationError ||
    e instanceof DraftNotFoundError ||
    e instanceof DraftValidationError
  ) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  return false;
}

/* ─── Creator accounts ───────────────────────────────────────────────── */

router.post("/creators/signup", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreatorSignupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid signup payload"));
      return;
    }
    const result = await signupCreator(ctx, parsed.data);
    res.json(ok(result));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

router.get("/creators", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSkillsSchema.pick({ cursor: true, limit: true }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listCreators(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

router.post("/creators/dashboard", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = DashboardSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Missing apiToken"));
      return;
    }
    const summary = await getCreatorDashboard(ctx, parsed.data.apiToken);
    res.json(ok(summary));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

router.get("/creators/:handle", requireTenant(), async (req, res, next) => {
  try {
    const handle = String(req.params["handle"] ?? "").toLowerCase();
    const account = await getCreatorByHandle(handle);
    if (!account) {
      res.status(404).json(err("CREATOR_NOT_FOUND", "Unknown creator"));
      return;
    }
    res.json(ok(account));
  } catch (e) {
    next(e);
  }
});

/* ─── Store skills ────────────────────────────────────────────────────── */

router.get("/skills", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSkillsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listStoreSkills(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

router.post("/skills/publish", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid publish payload"));
      return;
    }
    const row = await publishDraft(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

router.get("/skills/updates", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const updates = await checkUpdates(ctx);
    res.json(ok({ updates }));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

router.get("/skills/:creatorHandle/:slug", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SkillKeySchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill key"));
      return;
    }
    const row = await getStoreSkill(ctx, parsed.data.creatorHandle, parsed.data.slug);
    if (!row) {
      res.status(404).json(err("STORE_SKILL_NOT_FOUND", "Unknown store skill"));
      return;
    }
    const versions = await listVersions(ctx, parsed.data.creatorHandle, parsed.data.slug);
    res.json(ok({ skill: row, versions }));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

router.post("/skills/:creatorHandle/:slug/install", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SkillKeySchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid skill key"));
      return;
    }
    const result = await installStoreSkill(ctx, parsed.data.creatorHandle, parsed.data.slug);
    res.json(ok(result));
  } catch (e) {
    if (handleStoreError(e, res)) return;
    next(e);
  }
});

export default router;
