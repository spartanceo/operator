/**
 * /api/distribution — platform distribution & code-signing surface.
 *
 * Endpoints:
 *   GET    /distribution/build              — current build attestation
 *   POST   /distribution/build              — desktop shell reports its build
 *   GET    /distribution/permissions        — OS permission status + instructions
 *   POST   /distribution/permissions/:id    — desktop shell reports OS verdict
 *
 * Read-only endpoints are tenant-scoped so probing the surface anonymously
 * is impossible. Mutating endpoints accept the desktop-shell payload and
 * cache it per-tenant in memory — losing the cache on restart is correct
 * because the shell re-reports on its next launch.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  type Platform,
  type PermissionId,
  type PermissionStatus,
  getBuildAttestation,
  listPermissions,
  reportBuildAttestation,
  reportPermissionStatus,
} from "../../services/distribution.service";

const router: IRouter = Router();

const PlatformSchema = z.enum(["darwin", "win32", "linux", "unknown"]);
const ChannelSchema = z.enum(["stable", "beta", "canary", "dev"]);

const ReportBuildSchema = z.object({
  platform: PlatformSchema.optional(),
  arch: z.string().min(1).max(32).optional(),
  version: z.string().min(1).max(64).optional(),
  channel: ChannelSchema.optional(),
  builtAt: z.string().datetime().nullable().optional(),
  signed: z.boolean().optional(),
  certificateSubject: z.string().min(1).max(512).nullable().optional(),
  certificateThumbprint: z.string().min(1).max(128).nullable().optional(),
  hardenedRuntime: z.boolean().optional(),
  notarized: z.boolean().optional(),
  notarizationTicket: z.string().min(1).max(256).nullable().optional(),
  stapled: z.boolean().optional(),
  sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/, "sha256 must be 64 hex chars")
    .nullable()
    .optional(),
  privacyManifest: z.boolean().optional(),
});

const PermissionIdSchema = z.enum([
  "screen_recording",
  "accessibility",
  "microphone",
  "camera",
  "screen_capture",
  "automation",
]);

const PermissionStatusSchema = z.enum([
  "granted",
  "denied",
  "not_determined",
  "restricted",
  "unsupported",
  "unknown",
]);

const ReportPermissionSchema = z.object({
  status: PermissionStatusSchema,
  platform: PlatformSchema.optional(),
});

const ListPermissionsQuery = z.object({
  platform: PlatformSchema.optional(),
});

router.get("/build", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const att = getBuildAttestation(ctx.tenantId);
    res.json(ok(att));
  } catch (e) {
    next(e);
  }
});

router.post("/build", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ReportBuildSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid build attestation payload"));
      return;
    }
    const att = reportBuildAttestation(ctx.tenantId, parsed.data);
    res.json(ok(att));
  } catch (e) {
    next(e);
  }
});

router.get("/permissions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListPermissionsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid platform filter"));
      return;
    }
    const platform: Platform | undefined = parsed.data.platform;
    const result = listPermissions(ctx.tenantId, platform);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/permissions/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const idParsed = PermissionIdSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json(err("VALIDATION", "Unknown permission id"));
      return;
    }
    const bodyParsed = ReportPermissionSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid permission status payload"));
      return;
    }
    const id: PermissionId = idParsed.data;
    const status: PermissionStatus = bodyParsed.data.status;
    const platform: Platform | undefined = bodyParsed.data.platform;
    const view = reportPermissionStatus(ctx.tenantId, id, status, platform);
    if (!view) {
      res.status(404).json(err("NOT_FOUND", "Permission not supported on this platform"));
      return;
    }
    res.json(ok(view));
  } catch (e) {
    next(e);
  }
});

export default router;
