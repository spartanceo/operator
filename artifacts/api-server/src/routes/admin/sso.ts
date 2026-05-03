/**
 * /api/admin/enterprise/sso — SSO configuration management (Task #55).
 *
 * All endpoints require `X-Tenant-ID` and run under the calling tenant's
 * scope. Audit log entries are appended for every mutation.
 */
import { Router, type IRouter, type Request } from "express";

import { ok, err, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  getBreakGlassStatus,
  provisionBreakGlass,
  revokeBreakGlass,
} from "../../services/break-glass.service";
import {
  issueScimToken,
  listScimTokens,
  revokeScimToken,
} from "../../services/scim.service";
import {
  applyIdpMetadataXml,
  deleteGroupMapping,
  getSsoConfig,
  listGroupMappings,
  listLoginEvents,
  persistOidcDiscovery,
  SsoConfigError,
  upsertGroupMapping,
  upsertSsoConfig,
  type SsoProtocol,
  type SsoRole,
} from "../../services/sso";
import { discover } from "../../services/sso/oidc";

const router: IRouter = Router();

function actor(req: Request): string {
  const a = req.headers["x-admin-actor"];
  if (typeof a === "string" && a.length > 0) return a;
  const userEmail = (req as unknown as { session?: { user?: { email?: string } } }).session?.user
    ?.email;
  return userEmail ?? "enterprise_admin";
}

// ─────────── Configuration ───────────────────────────────────────────────

router.get("/enterprise/sso/config", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  const cfg = await getSsoConfig(ctx);
  res.json(ok(cfg));
});

router.put("/enterprise/sso/config", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cfg = await upsertSsoConfig(ctx, actor(req), {
    protocol: typeof body["protocol"] === "string" ? (body["protocol"] as SsoProtocol) : undefined,
    displayName: typeof body["displayName"] === "string" ? body["displayName"] : undefined,
    emailDomain: typeof body["emailDomain"] === "string" ? body["emailDomain"] : undefined,
    enforced: typeof body["enforced"] === "boolean" ? body["enforced"] : undefined,
    jitProvisioning: typeof body["jitProvisioning"] === "boolean" ? body["jitProvisioning"] : undefined,
    singleLogoutEnabled:
      typeof body["singleLogoutEnabled"] === "boolean" ? body["singleLogoutEnabled"] : undefined,
    sessionTimeoutMinutes:
      typeof body["sessionTimeoutMinutes"] === "number" ? body["sessionTimeoutMinutes"] : undefined,
    samlEntityId: parseStringOrNull(body["samlEntityId"]),
    samlSsoUrl: parseStringOrNull(body["samlSsoUrl"]),
    samlSloUrl: parseStringOrNull(body["samlSloUrl"]),
    samlSigningCertPem: parseStringOrNull(body["samlSigningCertPem"]),
    samlWantAssertionsSigned:
      typeof body["samlWantAssertionsSigned"] === "boolean"
        ? body["samlWantAssertionsSigned"]
        : undefined,
    oidcIssuer: parseStringOrNull(body["oidcIssuer"]),
    oidcClientId: parseStringOrNull(body["oidcClientId"]),
    oidcClientSecret: parseStringOrNull(body["oidcClientSecret"]),
  });
  res.json(ok(cfg));
});

router.post("/enterprise/sso/idp-metadata", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const xml = body["xml"];
  if (typeof xml !== "string" || xml.length === 0) {
    res.status(400).json(err("INVALID_BODY", "`xml` is required"));
    return;
  }
  try {
    const cfg = await applyIdpMetadataXml(ctx, actor(req), xml);
    res.json(ok(cfg));
  } catch (e) {
    if (e instanceof SsoConfigError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    throw e;
  }
});

router.post(
  "/enterprise/sso/oidc-discovery",
  adminLimiter,
  requireTenant(),
  async (_req, res) => {
    const ctx = requireTenantContext();
    const cfg = await getSsoConfig(ctx);
    if (!cfg?.oidc.issuer) {
      res.status(400).json(err("NO_ISSUER", "OIDC issuer not configured"));
      return;
    }
    const { doc, error } = await discover(cfg.oidc.issuer);
    if (!doc) {
      res.status(502).json(err("DISCOVERY_FAILED", error ?? "discovery failed"));
      return;
    }
    await persistOidcDiscovery(ctx, JSON.stringify(doc));
    res.json(ok({ refreshed: true, fetched: doc }));
  },
);

// ─────────── Group → role mappings ───────────────────────────────────────

router.get("/enterprise/sso/group-mappings", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  res.json(ok(await listGroupMappings(ctx)));
});

router.put("/enterprise/sso/group-mappings", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const groupName = body["groupName"];
  const role = body["role"];
  if (typeof groupName !== "string" || typeof role !== "string") {
    res.status(400).json(err("INVALID_BODY", "`groupName` and `role` are required"));
    return;
  }
  if (role !== "admin" && role !== "standard" && role !== "readonly") {
    res.status(400).json(err("INVALID_ROLE", "role must be admin|standard|readonly"));
    return;
  }
  const rule = await upsertGroupMapping(ctx, actor(req), {
    groupName,
    role: role as SsoRole,
    priority: typeof body["priority"] === "number" ? body["priority"] : undefined,
  });
  res.json(ok(rule));
});

router.delete(
  "/enterprise/sso/group-mappings/:id",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const out = await deleteGroupMapping(ctx, actor(req), String(req.params["id"]));
    res.json(ok(out));
  },
);

// ─────────── Login events / health ───────────────────────────────────────

router.get("/enterprise/sso/login-events", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limit = req.query["limit"] ? Number(req.query["limit"]) : undefined;
  const page = await listLoginEvents(ctx, { cursor, limit });
  res.json(pageOk(page.items, page.nextCursor));
});

// ─────────── SCIM tokens ─────────────────────────────────────────────────

router.get("/enterprise/sso/scim-tokens", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  res.json(ok(await listScimTokens(ctx)));
});

router.post("/enterprise/sso/scim-tokens", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const label = typeof req.body?.label === "string" ? req.body.label : "untitled";
  const issued = await issueScimToken(ctx, actor(req), label);
  res.json(ok(issued));
});

router.delete(
  "/enterprise/sso/scim-tokens/:id",
  adminLimiter,
  requireTenant(),
  async (req, res) => {
    const ctx = requireTenantContext();
    const out = await revokeScimToken(ctx, actor(req), String(req.params["id"]));
    res.json(ok(out));
  },
);

// ─────────── Break-glass ─────────────────────────────────────────────────

router.get("/enterprise/break-glass", adminLimiter, requireTenant(), async (_req, res) => {
  const ctx = requireTenantContext();
  res.json(ok(await getBreakGlassStatus(ctx)));
});

router.post("/enterprise/break-glass", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const email = typeof req.body?.email === "string" ? req.body.email : null;
  if (!email) {
    res.status(400).json(err("INVALID_BODY", "`email` is required"));
    return;
  }
  const issued = await provisionBreakGlass(ctx, actor(req), email);
  res.json(ok(issued));
});

router.delete("/enterprise/break-glass", adminLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  res.json(ok(await revokeBreakGlass(ctx, actor(req))));
});

function parseStringOrNull(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === "string") return v;
  return undefined;
}

export default router;
