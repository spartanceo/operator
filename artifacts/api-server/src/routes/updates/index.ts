/**
 * /api/updates — Desktop App Auto-Update System (Task #48).
 *
 * Endpoints (all tenant-scoped — anonymous probes are rejected):
 *
 *   GET    /updates/check                  — main client poll: pinning +
 *                                            staged-rollout + delta selection
 *   GET    /updates/release/:version       — full manifest for a specific
 *                                            version (sig included)
 *   GET    /updates/changelog/:version     — human-readable release notes
 *   GET    /updates/server-health          — status-page surface
 *   POST   /updates/install/start          — desktop shell records a new
 *                                            install attempt
 *   POST   /updates/install/result         — desktop shell flips the
 *                                            install state machine
 *   GET    /updates/install/attempts       — recent attempts for a device
 *   GET    /updates/rollback               — crash-detector verdict
 *   POST   /updates/verify                 — server-side signature verify
 *                                            (helper for shells that can't
 *                                             link an ed25519 verifier)
 *   GET    /updates/pinning                — current pinning view
 *   PUT    /updates/pinning                — set pinning (admin/enterprise)
 *
 *   POST   /updates/admin/releases         — publish a new release
 *   PATCH  /updates/admin/releases/:rid    — set rollout / yank
 *   GET    /updates/admin/releases         — list releases
 *
 * Note: admin routes carry no role gate yet — Task #4 (Authentication)
 * + Task #46 (Admin role-check middleware) will layer that in. A TODO is
 * left at every admin handler so the seam is obvious.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  type InstallStatus,
  type Platform,
  type ReleaseChannel,
  UpdateValidationError,
  canonicalSigningPayload,
  checkForUpdates,
  evaluateRollback,
  getPinning,
  getRelease,
  listInstallAttempts,
  listReleases,
  publishRelease,
  recordInstallResult,
  serverHealth,
  setPinning,
  setRolloutPercentage,
  startInstall,
  verifySignature,
  yankRelease,
} from "../../services/updates.service";

const router: IRouter = Router();

const PlatformSchema = z.enum(["darwin", "win32", "linux"]);
const ChannelSchema = z.enum(["stable", "beta", "canary", "dev"]);
const KindSchema = z.enum(["full", "delta"]);
const VersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?$/, "Invalid version");
const ArchSchema = z.string().min(1).max(32);
const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/, "sha256 must be 64 hex chars");

const CheckQuery = z.object({
  platform: PlatformSchema.optional(),
  arch: ArchSchema.optional(),
  channel: ChannelSchema.optional(),
  currentVersion: VersionSchema.optional(),
});

router.get("/check", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CheckQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query parameters"));
      return;
    }
    const result = await checkForUpdates({
      tenantId: ctx.tenantId,
      ...parsed.data,
    });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

const ReleaseQuery = z.object({
  channel: ChannelSchema.optional(),
  platform: PlatformSchema,
  arch: ArchSchema.optional(),
});

router.get("/release/:version", requireTenant(), async (req, res, next) => {
  try {
    const versionParse = VersionSchema.safeParse(req.params.version);
    if (!versionParse.success) {
      res.status(400).json(err("VALIDATION", "Invalid version"));
      return;
    }
    const queryParse = ReleaseQuery.safeParse(req.query);
    if (!queryParse.success) {
      res.status(400).json(err("VALIDATION", "Invalid query parameters"));
      return;
    }
    const channel: ReleaseChannel = queryParse.data.channel ?? "stable";
    const arch = queryParse.data.arch ?? "x64";
    const manifest = await getRelease(channel, queryParse.data.platform, arch, versionParse.data);
    if (!manifest) {
      res.status(404).json(err("NOT_FOUND", "Release not found"));
      return;
    }
    res.json(ok(manifest));
  } catch (e) {
    next(e);
  }
});

router.get("/changelog/:version", requireTenant(), async (req, res, next) => {
  try {
    const versionParse = VersionSchema.safeParse(req.params.version);
    if (!versionParse.success) {
      res.status(400).json(err("VALIDATION", "Invalid version"));
      return;
    }
    const queryParse = ReleaseQuery.safeParse(req.query);
    if (!queryParse.success) {
      res.status(400).json(err("VALIDATION", "Invalid query parameters"));
      return;
    }
    const channel: ReleaseChannel = queryParse.data.channel ?? "stable";
    const arch = queryParse.data.arch ?? "x64";
    const manifest = await getRelease(channel, queryParse.data.platform, arch, versionParse.data);
    if (!manifest) {
      res.status(404).json(err("NOT_FOUND", "Release not found"));
      return;
    }
    res.json(
      ok({
        version: manifest.version,
        channel: manifest.channel,
        publishedAt: manifest.publishedAt,
        releaseNotes: manifest.releaseNotes,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/server-health", requireTenant(), async (_req, res, next) => {
  try {
    const snapshot = await serverHealth();
    res.json(ok(snapshot));
  } catch (e) {
    next(e);
  }
});

const InstallStartSchema = z.object({
  deviceId: z.string().min(1).max(128),
  fromVersion: VersionSchema.nullable().optional(),
  toVersion: VersionSchema,
  platform: PlatformSchema,
  arch: ArchSchema.optional(),
  channel: ChannelSchema.optional(),
  updateKind: KindSchema,
});

router.post("/install/start", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InstallStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid install payload"));
      return;
    }
    const view = await startInstall(ctx.tenantId, ctx.workspaceId ?? `default-${ctx.tenantId}`, {
      ...parsed.data,
      fromVersion: parsed.data.fromVersion ?? null,
    });
    res.status(201).json(ok(view));
  } catch (e) {
    if (e instanceof UpdateValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

const InstallStatusSchema = z.enum([
  "downloading",
  "downloaded",
  "verifying",
  "verified",
  "installing",
  "installed",
  "launch_pending",
  "launch_succeeded",
  "launch_failed",
  "rolled_back",
  "aborted",
  "signature_invalid",
]);

const InstallResultSchema = z.object({
  attemptId: z.string().min(1).max(64),
  status: InstallStatusSchema,
  failureReason: z.string().max(1024).optional(),
  signatureVerified: z.boolean().optional(),
  bytesDownloaded: z.number().int().min(0).optional(),
});

router.post("/install/result", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InstallResultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid result payload"));
      return;
    }
    const view = await recordInstallResult(ctx.tenantId, {
      ...parsed.data,
      status: parsed.data.status as InstallStatus,
    });
    if (!view) {
      res.status(404).json(err("NOT_FOUND", "Install attempt not found"));
      return;
    }
    res.json(ok(view));
  } catch (e) {
    if (e instanceof UpdateValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

const AttemptsQuery = z.object({
  deviceId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

router.get("/install/attempts", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = AttemptsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query parameters"));
      return;
    }
    const items = await listInstallAttempts(
      ctx.tenantId,
      parsed.data.deviceId ?? null,
      parsed.data.limit ?? 20,
    );
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

const RollbackQuery = z.object({
  deviceId: z.string().min(1).max(128),
});

router.get("/rollback", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RollbackQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "deviceId is required"));
      return;
    }
    const decision = await evaluateRollback(ctx.tenantId, parsed.data.deviceId);
    res.json(ok(decision));
  } catch (e) {
    next(e);
  }
});

const VerifySchema = z.object({
  version: VersionSchema,
  platform: PlatformSchema,
  arch: ArchSchema.optional(),
  sha256: Sha256Schema,
  size: z.number().int().min(0),
  kind: KindSchema,
  signature: z.string().min(1).max(2048),
});

router.post("/verify", requireTenant(), async (req, res, next) => {
  try {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid verification payload"));
      return;
    }
    const canonical = canonicalSigningPayload({
      version: parsed.data.version,
      platform: parsed.data.platform,
      arch: parsed.data.arch ?? "x64",
      sha256: parsed.data.sha256,
      size: parsed.data.size,
      kind: parsed.data.kind,
    });
    const result = verifySignature(canonical, parsed.data.signature);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/pinning", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const view = await getPinning(ctx.tenantId);
    res.json(ok(view));
  } catch (e) {
    next(e);
  }
});

const PinningSchema = z.object({
  pinnedVersion: VersionSchema.nullable().optional(),
  pinnedChannel: ChannelSchema.nullable().optional(),
  autoUpdateEnabled: z.boolean().optional(),
  managedBy: z.enum(["user", "admin", "enterprise"]).optional(),
  managedByUserId: z.string().min(1).max(128).nullable().optional(),
  notes: z.string().max(1024).nullable().optional(),
});

router.put("/pinning", requireTenant(), async (req, res, next) => {
  try {
    // TODO(Task #4 + Task #46): role-gate to admin/enterprise once the
    // auth middleware lands. For now any authenticated tenant can pin
    // their own install — no escalation surface, since pinning is per-tenant.
    const ctx = requireTenantContext();
    const parsed = PinningSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pinning payload"));
      return;
    }
    const view = await setPinning(ctx.tenantId, parsed.data);
    res.json(ok(view));
  } catch (e) {
    if (e instanceof UpdateValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

// ── Admin: release publishing & rollout controls ─────────────────────────

const PublishSchema = z.object({
  version: VersionSchema,
  channel: ChannelSchema.optional(),
  platform: PlatformSchema,
  arch: ArchSchema.optional(),
  fullUrl: z.string().url().max(2048),
  fullSha256: Sha256Schema,
  fullSize: z.number().int().min(0).optional(),
  delta: z
    .object({
      fromVersion: VersionSchema,
      url: z.string().url().max(2048),
      sha256: Sha256Schema,
      size: z.number().int().min(0).optional(),
    })
    .optional(),
  releaseNotes: z.string().max(16_384).optional(),
  rolloutPercentage: z.number().int().min(0).max(100).optional(),
});

router.post("/admin/releases", requireTenant(), async (req, res, next) => {
  try {
    // TODO(Task #4 + Task #46): role-gate to super-admin once auth lands.
    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid release payload"));
      return;
    }
    const manifest = await publishRelease(parsed.data);
    res.status(201).json(ok(manifest));
  } catch (e) {
    if (e instanceof UpdateValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

const ListReleasesQuery = z.object({
  channel: ChannelSchema.optional(),
  platform: PlatformSchema.optional(),
  arch: ArchSchema.optional(),
  includeYanked: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get("/admin/releases", requireTenant(), async (req, res, next) => {
  try {
    const parsed = ListReleasesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query parameters"));
      return;
    }
    const items = await listReleases(parsed.data);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

const PatchReleaseSchema = z.object({
  channel: ChannelSchema,
  platform: PlatformSchema,
  arch: ArchSchema.optional(),
  version: VersionSchema,
  rolloutPercentage: z.number().int().min(0).max(100).optional(),
  yank: z
    .object({
      reason: z.string().min(1).max(512),
    })
    .optional(),
});

router.patch("/admin/releases", requireTenant(), async (req, res, next) => {
  try {
    // TODO(Task #4 + Task #46): role-gate to super-admin once auth lands.
    const parsed = PatchReleaseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid patch payload"));
      return;
    }
    const arch = parsed.data.arch ?? "x64";
    let manifest = null;
    if (parsed.data.yank) {
      manifest = await yankRelease(
        parsed.data.channel,
        parsed.data.platform,
        arch,
        parsed.data.version,
        parsed.data.yank.reason,
      );
    } else if (parsed.data.rolloutPercentage !== undefined) {
      manifest = await setRolloutPercentage(
        parsed.data.channel,
        parsed.data.platform,
        arch,
        parsed.data.version,
        parsed.data.rolloutPercentage,
      );
    } else {
      res.status(400).json(err("VALIDATION", "Nothing to update"));
      return;
    }
    if (!manifest) {
      res.status(404).json(err("NOT_FOUND", "Release not found"));
      return;
    }
    res.json(ok(manifest));
  } catch (e) {
    next(e);
  }
});

export default router;
