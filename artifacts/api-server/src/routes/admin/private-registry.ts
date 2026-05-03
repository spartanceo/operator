/**
 * /api/admin/enterprise/private-registry — IT-admin endpoints for the
 * org-private skill registry (Task #60).
 *
 * Surfaces:
 *   - GET  /settings                 — read registry mode + signing key
 *   - PATCH /settings                — update mode / remote URL / pubkey
 *   - POST  /sync                    — pull manifest from remote registry
 *   - GET  /packages                 — list packages (status / latest filter)
 *   - POST /packages                 — submit a new private skill version
 *   - POST /packages/:id/approve     — approve a pending submission
 *   - POST /packages/:id/reject      — reject a pending submission
 *   - POST /packages/:id/push        — push approved package to all seats
 *
 * All writes append a `private_skill.*` / `private_registry.*` entry to
 * the tamper-evident audit chain.
 */
import { Router, type IRouter } from "express";

import { ok, err, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  approvePackage,
  getOrCreateSettings,
  listPackages,
  PrivateRegistryError,
  pushToTeam,
  rejectPackage,
  submitPackage,
  syncFromRemote,
  updateSettings,
  type Visibility,
} from "../../services/private-registry.service";

const router: IRouter = Router();

function actor(req: {
  headers: Record<string, unknown>;
  session?: { user?: { email?: string } };
}): string {
  const headerActor = req.headers["x-admin-actor"];
  if (typeof headerActor === "string" && headerActor.length > 0) return headerActor;
  return req.session?.user?.email ?? "enterprise_admin";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asStringOrNull(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === "string" ? v : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

router.get(
  "/enterprise/private-registry/settings",
  adminLimiter,
  requireTenant(),
  async (_req, res) => {
    const ctx = requireTenantContext();
    const settings = await getOrCreateSettings(ctx);
    res.json(ok(settings));
  },
);

router.patch(
  "/enterprise/private-registry/settings",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const body = req.body ?? {};
    const mode = body.mode === "local" || body.mode === "remote" ? body.mode : undefined;
    const updated = await updateSettings(ctx, actor(req as never), {
      mode,
      remoteRegistryUrl: asStringOrNull(body.remoteRegistryUrl),
      signingPublicKeyPem: asStringOrNull(body.signingPublicKeyPem),
      requireSignature:
        typeof body.requireSignature === "boolean" ? body.requireSignature : undefined,
    });
    res.json(ok(updated));
  },
);

router.post(
  "/enterprise/private-registry/sync",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    try {
      const result = await syncFromRemote(ctx, actor(req as never));
      res.json(ok(result));
    } catch (e) {
      if (e instanceof PrivateRegistryError) {
        res.status(400).json(err(e.code, e.message));
        return;
      }
      throw e;
    }
  },
);

router.get(
  "/enterprise/private-registry/packages",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const cursor = asString(req.query["cursor"]) ?? null;
    const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
    const statusRaw = asString(req.query["status"]);
    const status =
      statusRaw === "pending" ||
      statusRaw === "approved" ||
      statusRaw === "rejected" ||
      statusRaw === "superseded" ||
      statusRaw === "all"
        ? statusRaw
        : undefined;
    const latestOnly = req.query["latestOnly"] === "true";
    const page = await listPackages(ctx, { cursor, limit, status, latestOnly });
    res.json(pageOk(page.items, page.nextCursor));
  },
);

router.post(
  "/enterprise/private-registry/packages",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const body = req.body ?? {};
    if (typeof body.slug !== "string" || typeof body.name !== "string" || typeof body.content !== "string") {
      res.status(400).json(err("INVALID_BODY", "`slug`, `name`, `content` are required"));
      return;
    }
    const visibility: Visibility | undefined =
      body.visibility === "all" || body.visibility === "roles" || body.visibility === "workspaces"
        ? body.visibility
        : undefined;
    try {
      const pkg = await submitPackage(ctx, actor(req as never), {
        slug: body.slug,
        name: body.name,
        description: asString(body.description),
        content: body.content,
        modelTags: asStringArray(body.modelTags),
        triggers: asStringArray(body.triggers),
        category: asString(body.category),
        documentation: asString(body.documentation),
        visibility,
        visibilityTargets: asStringArray(body.visibilityTargets),
        mandatory: typeof body.mandatory === "boolean" ? body.mandatory : undefined,
        signature: asString(body.signature),
        signatureAlgo: asString(body.signatureAlgo),
      });
      res.status(201).json(ok(pkg));
    } catch (e) {
      if (e instanceof PrivateRegistryError) {
        res.status(400).json(err(e.code, e.message));
        return;
      }
      throw e;
    }
  },
);

router.post(
  "/enterprise/private-registry/packages/:id/approve",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const body = req.body ?? {};
    try {
      const pkg = await approvePackage(
        ctx,
        actor(req as never),
        String(req.params["id"]),
        asString(body.notes) ?? "",
      );
      res.json(ok(pkg));
    } catch (e) {
      if (e instanceof PrivateRegistryError) {
        res.status(e.code === "NOT_FOUND" ? 404 : 400).json(err(e.code, e.message));
        return;
      }
      throw e;
    }
  },
);

router.post(
  "/enterprise/private-registry/packages/:id/reject",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const body = req.body ?? {};
    if (typeof body.reason !== "string" || body.reason.length === 0) {
      res.status(400).json(err("INVALID_BODY", "`reason` is required"));
      return;
    }
    try {
      const pkg = await rejectPackage(
        ctx,
        actor(req as never),
        String(req.params["id"]),
        body.reason,
      );
      res.json(ok(pkg));
    } catch (e) {
      if (e instanceof PrivateRegistryError) {
        res.status(e.code === "NOT_FOUND" ? 404 : 400).json(err(e.code, e.message));
        return;
      }
      throw e;
    }
  },
);

router.post(
  "/enterprise/private-registry/packages/:id/push",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    try {
      const result = await pushToTeam(
        ctx,
        actor(req as never),
        String(req.params["id"]),
      );
      res.json(ok(result));
    } catch (e) {
      if (e instanceof PrivateRegistryError) {
        res.status(e.code === "NOT_FOUND" ? 404 : 400).json(err(e.code, e.message));
        return;
      }
      throw e;
    }
  },
);

export default router;
