/**
 * /api/skills/private — member-facing endpoints for the org-private
 * skill registry (Task #60).
 *
 *   - GET    /                — list approved packages visible to the
 *                                caller (after visibility scope filter)
 *   - GET    /installed       — list installations in the caller's tenant
 *   - POST   /:id/install     — install an approved package (member-
 *                                initiated; admin push uses the admin
 *                                router)
 *   - DELETE /:slug           — uninstall by slug (blocked when the
 *                                package is mandatory)
 */
import { Router, type IRouter } from "express";

import { ok, err } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  installPackage,
  listInstallations,
  listVisibleForMember,
  PrivateRegistryError,
  uninstallPackage,
} from "../../services/private-registry.service";

const router: IRouter = Router();

function viewerFromReq(req: {
  headers: Record<string, unknown>;
  session?: { user?: { role?: string; workspaceId?: string } };
}): { role: string | null; workspaceId: string | null } {
  const headerRole = req.headers["x-user-role"];
  const headerWs = req.headers["x-workspace-id"];
  const role =
    typeof headerRole === "string" ? headerRole : req.session?.user?.role ?? null;
  const workspaceId =
    typeof headerWs === "string" ? headerWs : req.session?.user?.workspaceId ?? null;
  return { role, workspaceId };
}

function actor(req: {
  headers: Record<string, unknown>;
  session?: { user?: { email?: string } };
}): string {
  const headerActor = req.headers["x-actor"];
  if (typeof headerActor === "string" && headerActor.length > 0) return headerActor;
  return req.session?.user?.email ?? "member";
}

router.get("/private", requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const items = await listVisibleForMember(ctx, viewerFromReq(req as never));
  res.json(ok({ items }));
});

router.get("/private/installed", requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const items = await listInstallations(ctx);
  res.json(ok({ items }));
});

router.post("/private/:id/install", requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  try {
    const installation = await installPackage(
      ctx,
      actor(req as never),
      String(req.params["id"]),
      "user",
    );
    res.status(201).json(ok(installation));
  } catch (e) {
    if (e instanceof PrivateRegistryError) {
      res
        .status(e.code === "NOT_FOUND" ? 404 : 400)
        .json(err(e.code, e.message));
      return;
    }
    throw e;
  }
});

router.delete("/private/:slug", requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  try {
    const result = await uninstallPackage(
      ctx,
      actor(req as never),
      String(req.params["slug"]),
    );
    res.json(ok(result));
  } catch (e) {
    if (e instanceof PrivateRegistryError) {
      res
        .status(e.code === "MANDATORY_LOCKED" ? 409 : 400)
        .json(err(e.code, e.message));
      return;
    }
    throw e;
  }
});

export default router;
