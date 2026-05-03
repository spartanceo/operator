/**
 * /api/backup — local-first encrypted backup, restore, scheduling, and
 * cloud-sync stub (Task #20).
 *
 * Routes:
 *   GET    /settings              fetch singleton settings
 *   PUT    /settings              partial update (cadence, retention, cloud)
 *   POST   /create                produce a fresh encrypted backup
 *   GET    /jobs                  paginated history
 *   GET    /jobs/:id              one job
 *   POST   /verify                integrity check on a supplied archive
 *   POST   /restore               replay snapshot (full or selective)
 *   POST   /scheduler/tick        scheduler driver (used by the test runner
 *                                 and the in-app prompt to surface due jobs)
 *
 * The mutating routes flow through the tight admin rate limiter — each
 * one is destructive and/or expensive, so the same 5-req/min cap that
 * guards GDPR export is the right policy here too.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  BackupDecryptError,
  BackupValidationError,
  createBackup,
  exportFullData,
  findDueScheduledBackups,
  getJob,
  getOrCreateSettings,
  listJobs,
  pruneOldBackups,
  restoreFromArchive,
  type RestoreScope,
  updateSettings,
  verifyArchive,
} from "../../services/backup.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const SCHEDULES = ["off", "daily", "weekly"] as const;
const PROVIDERS = ["icloud", "googleDrive", "dropbox", "s3"] as const;
const SCOPES = ["all", "knowledge", "memories", "settings", "conversations"] as const;

const UpdateSettingsSchema = z.object({
  schedule: z.enum(SCHEDULES).optional(),
  targetDirectory: z.string().min(1).max(500).nullable().optional(),
  retentionCount: z.number().int().min(1).max(365).optional(),
  cloudProvider: z.enum(PROVIDERS).nullable().optional(),
  cloudSettings: z.record(z.unknown()).nullable().optional(),
  cloudEnabled: z.boolean().optional(),
});

const PASSWORD = z.string().min(1).max(1024);

const CreateSchema = z.object({
  password: PASSWORD,
  uploadToCloud: z.boolean().optional(),
});

const VerifySchema = z.object({
  password: PASSWORD,
  archiveBase64: z.string().min(1).max(512 * 1024 * 1024 / 3), // base64 expansion of 256 MB cap
});

const RestoreSchema = z.object({
  password: PASSWORD,
  archiveBase64: z.string().min(1),
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length).optional(),
  replaceExisting: z.boolean().optional(),
});

const ExportFormatSchema = z.object({
  format: z.enum(["json", "markdown"]).optional(),
});

function handleBackupError(
  e: unknown,
  res: import("express").Response,
): boolean {
  if (e instanceof BackupValidationError) {
    res.status(400).json(err("VALIDATION", e.message));
    return true;
  }
  if (e instanceof BackupDecryptError) {
    res.status(400).json(err("DECRYPT_FAILED", e.message));
    return true;
  }
  return false;
}

router.get("/settings", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const settings = await getOrCreateSettings(ctx);
    res.json(ok(settings));
  } catch (e) {
    next(e);
  }
});

router.put("/settings", adminLimiter, requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(err("VALIDATION", "Invalid backup settings", parsed.error.flatten()));
      return;
    }
    const updated = await updateSettings(ctx, parsed.data);
    res.json(ok(updated));
  } catch (e) {
    if (handleBackupError(e, res)) return;
    next(e);
  }
});

router.post("/create", adminLimiter, requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(err("VALIDATION", "Invalid backup payload", parsed.error.flatten()));
      return;
    }
    const result = await createBackup(ctx, {
      password: parsed.data.password,
      uploadToCloud: parsed.data.uploadToCloud ?? false,
      trigger: "manual",
    });
    res.json(ok(result));
  } catch (e) {
    if (handleBackupError(e, res)) return;
    next(e);
  }
});

router.get("/jobs", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listJobs(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/jobs/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const job = await getJob(ctx, String(req.params.id));
    if (!job) {
      res.status(404).json(err("NOT_FOUND", "Backup job not found"));
      return;
    }
    res.json(ok(job));
  } catch (e) {
    next(e);
  }
});

router.post("/verify", adminLimiter, requireTenant(), async (req, res, next) => {
  try {
    requireTenantContext();
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(err("VALIDATION", "Invalid verify payload", parsed.error.flatten()));
      return;
    }
    const archive = Buffer.from(parsed.data.archiveBase64, "base64");
    const result = await verifyArchive(archive, parsed.data.password);
    res.json(ok(result));
  } catch (e) {
    if (handleBackupError(e, res)) return;
    next(e);
  }
});

router.post("/restore", adminLimiter, requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RestoreSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(err("VALIDATION", "Invalid restore payload", parsed.error.flatten()));
      return;
    }
    const archive = Buffer.from(parsed.data.archiveBase64, "base64");
    const result = await restoreFromArchive(ctx, archive, parsed.data.password, {
      scopes: parsed.data.scopes as RestoreScope[] | undefined,
      replaceExisting: parsed.data.replaceExisting,
    });
    res.json(ok(result));
  } catch (e) {
    if (handleBackupError(e, res)) return;
    next(e);
  }
});

router.post("/scheduler/tick", adminLimiter, requireTenant(), async (req, res, next) => {
  try {
    requireTenantContext();
    const now = Number(req.body?.now) || Date.now();
    const due = await findDueScheduledBackups(now);
    res.json(ok({ now: new Date(now).toISOString(), due }));
  } catch (e) {
    next(e);
  }
});

router.post("/prune", adminLimiter, requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const summary = await pruneOldBackups(ctx);
    res.json(ok(summary));
  } catch (e) {
    next(e);
  }
});

// Convenience: fetch the full GDPR-shaped data export from the backup
// router so a single client can consume "give me everything in one
// payload" without juggling two endpoints. Re-exposes
// `services/backup.service#exportFullData`.
router.get("/export/full", adminLimiter, requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const data = await exportFullData(ctx);
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

export default router;
export { ExportFormatSchema as __ExportFormatSchema };
