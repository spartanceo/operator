/**
 * /api/telemetry — opt-in analytics, crash reports, and the per-tenant
 * dashboard summary.
 *
 * The privacy enforcement layer lives in `telemetry.service.ts`; this
 * router is a thin Zod-validation + envelope shell around it. Default-OFF
 * is enforced by the service, not the route.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  eraseTelemetryData,
  getTelemetryConsent,
  getTelemetrySummary,
  listCrashReports,
  listTelemetryEvents,
  recordTelemetryEvents,
  submitCrashReport,
  TELEMETRY_CATEGORIES,
  TelemetryConsentDeniedError,
  type TelemetryCategory,
  updateTelemetryConsent,
} from "../../services/telemetry.service";

const router: IRouter = Router();

const ConsentSchema = z.object({
  optInUsage: z.boolean().optional(),
  optInPerformance: z.boolean().optional(),
  optInCrashes: z.boolean().optional(),
  optInOnboarding: z.boolean().optional(),
  optInMarketplace: z.boolean().optional(),
  revokeAll: z.boolean().optional(),
});

const EventInputSchema = z.object({
  category: z.enum(["feature_usage", "performance", "onboarding", "marketplace"]),
  eventName: z.string().min(1).max(120),
  payload: z.record(z.unknown()).optional(),
  opVersion: z.string().min(1).max(40).optional(),
  osPlatform: z.string().min(1).max(40).optional(),
  hardwareTier: z.string().min(1).max(20).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
});

const RecordEventsSchema = z.object({
  events: z.array(EventInputSchema).min(1).max(50),
});

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  category: z
    .enum(["feature_usage", "performance", "onboarding", "marketplace"])
    .optional(),
});

const CrashSchema = z.object({
  message: z.string().min(1).max(500),
  stackTrace: z.string().max(8000).optional(),
  breadcrumbs: z.string().max(8000).optional(),
  fingerprint: z.string().min(1).max(120).optional(),
  opVersion: z.string().min(1).max(40).optional(),
  osPlatform: z.string().min(1).max(40).optional(),
  osVersion: z.string().min(1).max(40).optional(),
  hardwareTier: z.string().min(1).max(20).optional(),
});

router.get("/consent", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const consent = await getTelemetryConsent(ctx);
    res.json(ok({ consent, categories: TELEMETRY_CATEGORIES }));
  } catch (e) {
    next(e);
  }
});

router.put("/consent", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ConsentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid consent payload"));
      return;
    }
    const { revokeAll, ...patch } = parsed.data;
    const consent = await updateTelemetryConsent(ctx, patch, {
      revokeAll: revokeAll ?? false,
    });
    res.json(ok({ consent, categories: TELEMETRY_CATEGORIES }));
  } catch (e) {
    next(e);
  }
});

router.delete("/data", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const receipt = await eraseTelemetryData(ctx);
    res.json(ok(receipt));
  } catch (e) {
    next(e);
  }
});

router.post("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RecordEventsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid telemetry events payload"));
      return;
    }
    const result = await recordTelemetryEvents(ctx, parsed.data.events);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/events", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const { category, ...page } = parsed.data;
    const result = await listTelemetryEvents(ctx, {
      ...page,
      ...(category !== undefined ? { category: category as TelemetryCategory } : {}),
    });
    res.json(pageOk(result.items, result.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/crashes", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CrashSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid crash report payload"));
      return;
    }
    const report = await submitCrashReport(ctx, parsed.data);
    res.json(ok(report));
  } catch (e) {
    if (e instanceof TelemetryConsentDeniedError) {
      res
        .status(403)
        .json(err("TELEMETRY_CONSENT_DENIED", "Crash reporting opt-in is disabled"));
      return;
    }
    next(e);
  }
});

router.get("/crashes", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const result = await listCrashReports(ctx, parsed.data);
    res.json(pageOk(result.items, result.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/summary", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const summary = await getTelemetrySummary(ctx);
    res.json(ok(summary));
  } catch (e) {
    next(e);
  }
});

export default router;
