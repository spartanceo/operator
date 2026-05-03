/**
 * /api/scim/v2 — SCIM 2.0 provisioning endpoint (Task #55, RFC 7644).
 *
 * Bearer auth: the IdP supplies an `Authorization: Bearer <token>` header
 * containing one of the `scim_provisioning_tokens` issued via the
 * Enterprise Admin portal. The token resolves to a tenant + org context
 * which is bound for the duration of the request.
 *
 * Responses use SCIM-native shapes (NOT the canonical OP envelope).
 * SCIM clients depend on the exact SCIM 2.0 Error/ListResponse schemas.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";

import { requireTenantContext, runWithTenantContext } from "../../lib/tenant-context";
import {
  ScimError,
  scimCreateGroup,
  scimCreateUser,
  scimDeactivateUser,
  scimDeleteGroup,
  scimGetGroup,
  scimGetUser,
  scimListGroups,
  scimListUsers,
  scimPatchGroup,
  scimPatchUser,
  scimReplaceUser,
  verifyScimToken,
} from "../../services/scim.service";

const router: IRouter = Router();

router.use(async (req, res, next) => {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    res.status(401).json(scimErrorBody(401, "Missing or malformed Authorization header"));
    return;
  }
  const token = auth.slice("Bearer ".length).trim();
  const resolved = await verifyScimToken(token);
  if (!resolved) {
    res.status(401).json(scimErrorBody(401, "Invalid or revoked bearer token"));
    return;
  }
  runWithTenantContext(
    {
      tenantId: resolved.tenantId,
      workspaceId: resolved.workspaceId,
      requestId: (res.locals["requestId"] as string | undefined) ?? "scim",
    },
    () => next(),
  );
});

// Service Provider configuration discovery.
router.get("/v2/ServiceProviderConfig", (_req, res) => {
  res.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://omninity.dev/docs/scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 1000 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Per-tenant SCIM provisioning token from the Enterprise Admin portal.",
        primary: true,
      },
    ],
  });
});

router.get("/v2/ResourceTypes", (_req, res) => {
  res.json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: 2,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: "urn:ietf:params:scim:schemas:core:2.0:User",
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
      },
    ],
  });
});

// ─────────── /Users ──────────────────────────────────────────────────────

router.get("/v2/Users", asyncHandler(async (req, res) => {
  const ctx = currentCtx();
  const filter = typeof req.query["filter"] === "string" ? req.query["filter"] : undefined;
  res.json(await scimListUsers(ctx, filter));
}));

router.post("/v2/Users", asyncHandler(async (req, res) => {
  const ctx = currentCtx();
  const created = await scimCreateUser(ctx, req.body ?? {});
  res.status(201).json(created);
}));

router.get("/v2/Users/:id", asyncHandler(async (req, res) => {
  const ctx = currentCtx();
  const user = await scimGetUser(ctx, String(req.params["id"]));
  if (!user) {
    res.status(404).json(scimErrorBody(404, "User not found"));
    return;
  }
  res.json(user);
}));

router.put("/v2/Users/:id", asyncHandler(async (req, res) => {
  const ctx = currentCtx();
  const updated = await scimReplaceUser(ctx, String(req.params["id"]), req.body ?? {});
  if (!updated) {
    res.status(404).json(scimErrorBody(404, "User not found"));
    return;
  }
  res.json(updated);
}));

router.patch("/v2/Users/:id", asyncHandler(async (req, res) => {
  const ctx = currentCtx();
  const updated = await scimPatchUser(ctx, String(req.params["id"]), req.body ?? {});
  if (!updated) {
    res.status(404).json(scimErrorBody(404, "User not found"));
    return;
  }
  res.json(updated);
}));

router.delete("/v2/Users/:id", asyncHandler(async (req, res) => {
  const ctx = currentCtx();
  const out = await scimDeactivateUser(ctx, String(req.params["id"]));
  if (!out.deactivated) {
    res.status(404).json(scimErrorBody(404, "User not found"));
    return;
  }
  res.status(204).end();
}));

// ─────────── /Groups ─────────────────────────────────────────────────────

router.get("/v2/Groups", asyncHandler(async (_req, res) => {
  res.json(await scimListGroups(currentCtx()));
}));

router.post("/v2/Groups", asyncHandler(async (req, res) => {
  const created = await scimCreateGroup(currentCtx(), req.body ?? {});
  res.status(201).json(created);
}));

router.get("/v2/Groups/:id", asyncHandler(async (req, res) => {
  const group = await scimGetGroup(currentCtx(), String(req.params["id"]));
  if (!group) {
    res.status(404).json(scimErrorBody(404, "Group not found"));
    return;
  }
  res.json(group);
}));

router.patch("/v2/Groups/:id", asyncHandler(async (req, res) => {
  const updated = await scimPatchGroup(currentCtx(), String(req.params["id"]), req.body ?? {});
  if (!updated) {
    res.status(404).json(scimErrorBody(404, "Group not found"));
    return;
  }
  res.json(updated);
}));

router.delete("/v2/Groups/:id", asyncHandler(async (req, res) => {
  const out = await scimDeleteGroup(currentCtx(), String(req.params["id"]));
  if (!out.removed) {
    res.status(404).json(scimErrorBody(404, "Group not found"));
    return;
  }
  res.status(204).end();
}));

// ─────────── helpers ─────────────────────────────────────────────────────

function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch((e) => {
      if (e instanceof ScimError) {
        res.status(e.status).json(e.toBody());
        return;
      }
      next(e);
    });
  };
}

function scimErrorBody(status: number, detail: string) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
}

function currentCtx() {
  return requireTenantContext();
}

export default router;
