/**
 * /api/privacy/* — privacy dashboard endpoints.
 *
 * Endpoints:
 *   GET  /events                    — audit-style event log (existing)
 *   POST /events                    — manual event append (existing)
 *   GET  /meter                     — privacy meter score + breakdown
 *   GET  /settings                  — per-feature privacy toggles
 *   PATCH /settings                 — update toggles
 *   GET  /inventory                 — "what's on my machine"
 *   GET  /network-calls             — paginated outbound call log
 *   GET  /network-calls/summary     — aggregated 30-day summary
 *   GET  /skill-permissions         — list per-skill permissions
 *   POST /skill-permissions/set     — grant/revoke a permission
 *   GET  /export                    — full data export bundle
 *   POST /delete-category           — delete one category of data
 *   GET  /erasure-requests          — list filed GDPR erasure requests
 *   POST /erasure-requests          — file a new request
 *   POST /erasure-requests/:id/cancel — cancel a pending request
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { getDataInventory } from "../../services/data-inventory.service";
import {
  cancelErasureRequest,
  createErasureRequest,
  deleteByCategory,
  exportAllData,
  listDeletableCategories,
  listErasureRequests,
  UnknownCategoryError,
} from "../../services/data-rights.service";
import {
  listNetworkCalls,
  summariseNetworkCalls,
} from "../../services/network-calls.service";
import { computePrivacyMeter } from "../../services/privacy-meter.service";
import {
  getPrivacySettings,
  updatePrivacySettings,
} from "../../services/privacy-settings.service";
import {
  listPrivacyEvents,
  logPrivacyEvent,
} from "../../services/privacy.service";
import {
  listSkillPermissions,
  PERMISSION_CATALOGUE,
  setSkillPermission,
} from "../../services/skill-permissions.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const CreateEventSchema = z.object({
  eventType: z.string().min(1).max(120),
  actor: z.string().min(1).max(200),
  target: z.string().min(1).max(500),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  detail: z.string().max(4000).optional(),
});

router.get("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listPrivacyEvents(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid privacy-event payload"));
      return;
    }
    const row = await logPrivacyEvent(ctx, parsed.data);
    if (!row) {
      res.status(500).json(err("PERSIST_FAILED", "Failed to record privacy event"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Meter
// --------------------------------------------------------------------------

router.get("/meter", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const reading = await computePrivacyMeter(ctx);
    res.json(ok(reading));
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------

const UpdateSettingsSchema = z.object({
  allowExternalModels: z.boolean().optional(),
  allowMarketplaceUsageStats: z.boolean().optional(),
  allowIntegrationDataReads: z.boolean().optional(),
  allowSkillNetworkCalls: z.boolean().optional(),
});

router.get("/settings", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getPrivacySettings(ctx)));
  } catch (e) {
    next(e);
  }
});

router.patch("/settings", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid settings payload"));
      return;
    }
    res.json(ok(await updatePrivacySettings(ctx, parsed.data)));
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Inventory
// --------------------------------------------------------------------------

router.get("/inventory", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await getDataInventory(ctx)));
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Network calls
// --------------------------------------------------------------------------

const NetworkCallsQuerySchema = PageSchema.extend({
  sinceMs: z.coerce.number().int().nonnegative().optional(),
});

router.get("/network-calls", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = NetworkCallsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query params"));
      return;
    }
    const page = await listNetworkCalls(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/network-calls/summary", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await summariseNetworkCalls(ctx)));
  } catch (e) {
    next(e);
  }
});

// --------------------------------------------------------------------------
// Skill permissions
// --------------------------------------------------------------------------

const SetSkillPermissionSchema = z.object({
  skillId: z.string().min(1).max(120),
  permission: z.enum(PERMISSION_CATALOGUE),
  granted: z.boolean(),
});

router.get("/skill-permissions", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok({ items: await listSkillPermissions(ctx) }));
  } catch (e) {
    next(e);
  }
});

router.post("/skill-permissions/set", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SetSkillPermissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid permission payload"));
      return;
    }
    const row = await setSkillPermission(
      ctx,
      parsed.data.skillId,
      parsed.data.permission,
      parsed.data.granted,
    );
    res.json(ok(row));
  } catch (e) {
    if (e instanceof Error && /Skill not found/.test(e.message)) {
      res.status(404).json(err("NOT_FOUND", e.message));
      return;
    }
    next(e);
  }
});

// --------------------------------------------------------------------------
// Data rights
// --------------------------------------------------------------------------

router.get("/export", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await exportAllData(ctx)));
  } catch (e) {
    next(e);
  }
});

router.get("/categories", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok({ items: listDeletableCategories() }));
  } catch (e) {
    next(e);
  }
});

const DeleteCategorySchema = z.object({
  category: z.string().min(1).max(120),
  confirm: z.literal(true),
});

router.post("/delete-category", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = DeleteCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Confirmation required"));
      return;
    }
    res.json(ok(await deleteByCategory(ctx, parsed.data.category)));
  } catch (e) {
    if (e instanceof UnknownCategoryError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

const CreateErasureSchema = z.object({
  requesterEmail: z.string().email().max(320),
  scope: z.enum(["all", "personal_data_only"]).optional(),
  reason: z.string().max(2000).optional(),
});

router.get("/erasure-requests", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listErasureRequests(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/erasure-requests", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateErasureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid erasure-request payload"));
      return;
    }
    res.json(ok(await createErasureRequest(ctx, parsed.data)));
  } catch (e) {
    next(e);
  }
});

router.post(
  "/erasure-requests/:id/cancel",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const id = String(req.params["id"] ?? "");
      if (!id) {
        res.status(400).json(err("VALIDATION", "id required"));
        return;
      }
      const row = await cancelErasureRequest(ctx, id);
      if (!row) {
        res.status(404).json(err("NOT_FOUND", "Erasure request not found"));
        return;
      }
      res.json(ok(row));
    } catch (e) {
      next(e);
    }
  },
);

export default router;
