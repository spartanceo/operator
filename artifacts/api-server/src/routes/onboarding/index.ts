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
import { checkSearXNGStatus } from "../../services/capability.service";

function ollamaHost(): string {
  return process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
}

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

/**
 * GET /api/onboarding/ollama-status
 *
 * Pings the local Ollama daemon at `localhost:11434/api/tags` and returns
 * whether it is reachable. This is what the launch-sequence screen polls
 * every 2 s when Ollama is not yet installed/running. The route is
 * tenant-scoped for consistency but performs no tenant-specific work —
 * the answer is process-wide.
 *
 * Returns `{ running: true }` when Ollama responds with any 2xx,
 * `{ running: false }` when the connection is refused or times out.
 */
router.get("/ollama-status", requireTenant(), async (_req, res, next) => {
  try {
    let running = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${ollamaHost()}/api/tags`, {
        method: "GET",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      running = r.ok;
    } catch {
      running = false;
    }
    res.json(ok({ running }));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/onboarding/web-search-status
 *
 * Checks whether SearXNG is reachable at the configured host (default:
 * http://localhost:8080). Used by the setup wizard to show the web search
 * onboarding card. Returns:
 *   { running: true }  — SearXNG is responding on the probe endpoint
 *   { running: false } — nothing listening at the configured host
 *
 * Also returns the Docker one-liner that starts SearXNG so the UI can
 * display it without hardcoding it in the frontend.
 */
router.get("/web-search-status", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const running = await checkSearXNGStatus(ctx);
    const dockerCommand = "docker run -d -p 8080:8080 searxng/searxng";
    res.json(ok({ running, dockerCommand }));
  } catch (e) {
    next(e);
  }
});

export default router;
