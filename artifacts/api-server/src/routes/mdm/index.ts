/**
 * /api/mdm — Enterprise Mobile Device Management surface (Task #56).
 *
 * IT departments deploy Omninity Operator at scale via Jamf Pro, Microsoft
 * Intune, or SCCM. This router owns four surfaces consumed by those
 * tools and the Enterprise Admin portal:
 *
 *   - Configuration schema     (`GET /mdm/schema`)
 *   - Per-tenant MDM profile   (`GET|PUT|DELETE /mdm/profile`)
 *   - Effective settings view  (`GET /mdm/settings`)  — admin-lock overlay
 *   - Profile artifact dl      (`GET /mdm/profile/mobileconfig|registry|admx`)
 *   - Installer catalog        (`GET /mdm/installers`,
 *                                `GET /mdm/installers/intune-detection`)
 *   - Fleet beacons            (`POST /mdm/fleet/beacon`,
 *                                `GET /mdm/fleet`,
 *                                `GET /mdm/fleet/summary`)
 *   - Deployment guides        (`GET /mdm/docs/{jamf|intune}`)
 *
 * Every endpoint is tenant-scoped via `requireTenant()`. Mutating
 * endpoints validate their payload via Zod and translate
 * `MdmValidationError` into a 400 envelope.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  INTUNE_DEPLOYMENT_GUIDE,
  JAMF_DEPLOYMENT_GUIDE,
  MdmValidationError,
  deleteProfile,
  generateAdmxTemplate,
  generateIntuneDetectionScript,
  generateMobileConfig,
  generateRegistryReg,
  getEffectiveSettings,
  getFleetSummary,
  getProfile,
  listConfigSchema,
  listFleet,
  listInstallerArtifacts,
  recordFleetBeacon,
  upsertProfile,
} from "../../services/mdm.service";

const router: IRouter = Router();

// ─── Schema ──────────────────────────────────────────────────────────────────

router.get("/schema", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok({ fields: listConfigSchema() }));
  } catch (e) {
    next(e);
  }
});

// ─── Profile ────────────────────────────────────────────────────────────────

const SourceSchema = z.enum(["manual", "jamf", "intune", "gpo", "sccm"]);

const UpsertProfileBody = z.object({
  source: SourceSchema.optional(),
  organisationName: z.string().min(1).max(256),
  profileVersion: z.number().int().positive().max(1_000_000).optional(),
  // Values are validated in depth by the service against the schema, so
  // we only enforce the outer shape here.
  values: z.record(z.unknown()).default({}),
  lockedKeys: z.array(z.string().min(1).max(128)).max(64).optional(),
});

router.get("/profile", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const profile = await getProfile(ctx);
    res.json(ok({ profile }));
  } catch (e) {
    next(e);
  }
});

router.put("/profile", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpsertProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid MDM profile payload"));
      return;
    }
    const profile = await upsertProfile(ctx, parsed.data);
    res.json(ok({ profile }));
  } catch (e) {
    if (e instanceof MdmValidationError) {
      res.status(400).json(err("VALIDATION", e.message));
      return;
    }
    next(e);
  }
});

router.delete("/profile", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const removed = await deleteProfile(ctx);
    res.json(ok({ removed }));
  } catch (e) {
    next(e);
  }
});

router.get("/settings", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const view = await getEffectiveSettings(ctx);
    res.json(ok(view));
  } catch (e) {
    next(e);
  }
});

// ─── Profile artifacts ───────────────────────────────────────────────────────

router.get(
  "/profile/mobileconfig",
  requireTenant(),
  async (_req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const xml = await generateMobileConfig(ctx);
      res
        .status(200)
        .setHeader("Content-Type", "application/x-apple-aspen-config")
        .setHeader(
          "Content-Disposition",
          'attachment; filename="omninity-operator.mobileconfig"',
        )
        .send(xml);
    } catch (e) {
      if (e instanceof MdmValidationError) {
        res.status(404).json(err("MDM_NO_PROFILE", e.message));
        return;
      }
      next(e);
    }
  },
);

router.get("/profile/registry", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const reg = await generateRegistryReg(ctx);
    res
      .status(200)
      .setHeader("Content-Type", "text/plain; charset=utf-8")
      .setHeader(
        "Content-Disposition",
        'attachment; filename="omninity-operator.reg"',
      )
      .send(reg);
  } catch (e) {
    if (e instanceof MdmValidationError) {
      res.status(404).json(err("MDM_NO_PROFILE", e.message));
      return;
    }
    next(e);
  }
});

router.get("/profile/admx", requireTenant(), async (_req, res, next) => {
  try {
    const xml = generateAdmxTemplate();
    res
      .status(200)
      .setHeader("Content-Type", "application/xml")
      .setHeader(
        "Content-Disposition",
        'attachment; filename="omninity-operator.admx"',
      )
      .send(xml);
  } catch (e) {
    next(e);
  }
});

// ─── Installer catalog ──────────────────────────────────────────────────────

router.get("/installers", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok({ installers: listInstallerArtifacts() }));
  } catch (e) {
    next(e);
  }
});

router.get(
  "/installers/intune-detection",
  requireTenant(),
  async (_req, res, next) => {
    try {
      const version = process.env["OMNINITY_BUILD_VERSION"] ?? "0.1.0";
      const script = generateIntuneDetectionScript(version);
      res
        .status(200)
        .setHeader("Content-Type", "text/plain; charset=utf-8")
        .setHeader(
          "Content-Disposition",
          'attachment; filename="OmninityOperator-Detection.ps1"',
        )
        .send(script);
    } catch (e) {
      next(e);
    }
  },
);

// ─── Fleet beacons ──────────────────────────────────────────────────────────

const BeaconBody = z.object({
  machineId: z.string().min(1).max(128),
  hostname: z.string().max(256).nullable().optional(),
  platform: z.enum(["darwin", "win32", "linux", "unknown"]),
  osVersion: z.string().max(128).nullable().optional(),
  appVersion: z.string().min(1).max(64),
  channel: z.enum(["stable", "beta", "canary", "dev"]).optional(),
  profileVersion: z.number().int().min(0).max(1_000_000).optional(),
});

const FleetListQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.post("/fleet/beacon", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = BeaconBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid fleet beacon payload"));
      return;
    }
    const device = await recordFleetBeacon(ctx, parsed.data);
    res.json(ok({ device }));
  } catch (e) {
    if (e instanceof MdmValidationError) {
      res.status(400).json(err("VALIDATION", e.message));
      return;
    }
    next(e);
  }
});

router.get("/fleet", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = FleetListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid fleet query"));
      return;
    }
    const page = await listFleet(
      ctx,
      parsed.data.cursor ?? null,
      parsed.data.limit ?? 20,
    );
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/fleet/summary", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const summary = await getFleetSummary(ctx);
    res.json(ok(summary));
  } catch (e) {
    next(e);
  }
});

// ─── Deployment guides ──────────────────────────────────────────────────────

router.get("/docs/jamf", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok({ format: "markdown", content: JAMF_DEPLOYMENT_GUIDE }));
  } catch (e) {
    next(e);
  }
});

router.get("/docs/intune", requireTenant(), async (_req, res, next) => {
  try {
    res.json(ok({ format: "markdown", content: INTUNE_DEPLOYMENT_GUIDE }));
  } catch (e) {
    next(e);
  }
});

export default router;
