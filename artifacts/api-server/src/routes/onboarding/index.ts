/**
 * /api/onboarding — first-run wizard, hardware probe, starter tasks.
 *
 * All routes are tenant-scoped; the singleton profile lives at the row
 * keyed by `tenantId`. Returning `null` for the GET when no profile exists
 * is intentional — the wizard renders on `null`, not on a 404, so there is
 * no "broken" state in the UI when a tenant first lands.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  detectHardware,
  generateStarterTasks,
  getOnboardingProfile,
  recommendModel,
  upsertOnboardingProfile,
} from "../../services/onboarding.service";

const router: IRouter = Router();

const HardwareSnapshotSchema = z.object({
  platform: z.string().min(1).max(40),
  arch: z.string().min(1).max(40),
  cpuCount: z.number().int().min(0).max(4096),
  cpuModel: z.string().max(200).nullable(),
  totalRamBytes: z.number().int().min(0),
  freeRamBytes: z.number().int().min(0),
  appleSilicon: z.boolean(),
  tier: z.enum(["low", "mid", "high", "pro"]),
  detectedAt: z.string().min(1).max(64),
});

const UpsertProfileSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  userType: z.enum(["personal", "business", "developer"]).optional(),
  useCase: z
    .enum(["productivity", "sales", "creative", "coding", "research"])
    .optional(),
  recommendedModel: z.string().min(1).max(200).optional(),
  completed: z.boolean().optional(),
  firstTaskCompleted: z.boolean().optional(),
  approvalTooltipSeen: z.boolean().optional(),
  hardwareSnapshot: HardwareSnapshotSchema.optional(),
});

router.get("/profile", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profile = await getOnboardingProfile(ctx);
    res.json(ok({ profile }));
  } catch (e) {
    next(e);
  }
});

router.put("/profile", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpsertProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(err("VALIDATION", "Invalid onboarding payload"));
      return;
    }
    const profile = await upsertOnboardingProfile(ctx, parsed.data);
    res.json(ok({ profile }));
  } catch (e) {
    next(e);
  }
});

router.get("/hardware", requireTenant(), async (_req, res, next) => {
  try {
    const hardware = detectHardware();
    const recommendation = recommendModel(hardware);
    res.json(ok({ hardware, recommendation }));
  } catch (e) {
    next(e);
  }
});

router.get("/starter-tasks", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profile = await getOnboardingProfile(ctx);
    const result = generateStarterTasks(profile?.useCase);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
