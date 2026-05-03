/**
 * /api/integrations — install, list, test, and execute connectors.
 *
 * The provider catalogue at GET /providers is anonymous-safe (no tenant
 * data) but kept tenant-gated for symmetry with every other route.
 *
 * Disconnected providers are returned by GET /:provider with a synthetic
 * row so the UI never has to special-case "not yet connected" — the same
 * shape always comes back, only `connectionStatus` changes.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  buildOAuthStart,
  completeOAuthCallback,
  connectIntegration,
  disconnectIntegration,
  executeIntegrationAction,
  getIntegration,
  IntegrationNotConnectedError,
  listIntegrations,
  testIntegration,
  UnknownActionError,
} from "../../services/integrations.service";
import { listProviders } from "../../services/integration-registry";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const ConnectSchema = z.object({
  credentials: z.record(z.string(), z.unknown()),
  accountLabel: z.string().min(1).max(120).optional(),
});

const OAuthStartSchema = z.object({
  redirectUri: z.string().min(1).max(2048).optional(),
});

const OAuthCallbackSchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(256).optional(),
  refreshToken: z.string().min(1).max(4096).optional(),
  accountLabel: z.string().min(1).max(120).optional(),
});

const ActionSchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
});

router.get("/providers", requireTenant(), async (_req, res, next) => {
  try {
    const providers = listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      category: p.category,
      authType: p.authType,
      description: p.description,
      oauthScopes: p.oauthScopes,
      fields: p.fields,
      actions: p.actions,
    }));
    res.json(ok({ providers }));
  } catch (e) {
    next(e);
  }
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listIntegrations(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

function handleProviderError(e: unknown, res: import("express").Response): boolean {
  const code = (e as { code?: string }).code;
  if (code === "UNKNOWN_PROVIDER") {
    res.status(404).json(err("NOT_FOUND", (e as Error).message));
    return true;
  }
  if (code === "NOT_CONNECTED") {
    res.status(409).json(err("NOT_CONNECTED", (e as Error).message));
    return true;
  }
  if (code === "UNKNOWN_ACTION") {
    res.status(404).json(err("NOT_FOUND", (e as Error).message));
    return true;
  }
  if (code === "VALIDATION") {
    res.status(400).json(err("VALIDATION", (e as Error).message));
    return true;
  }
  return false;
}

router.get("/:provider", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getIntegration(ctx, String(req.params.provider));
    res.json(ok(row));
  } catch (e) {
    if (handleProviderError(e, res)) return;
    next(e);
  }
});

router.put("/:provider", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ConnectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid integration payload"));
      return;
    }
    const row = await connectIntegration(
      ctx,
      String(req.params.provider),
      parsed.data,
    );
    res.json(ok(row));
  } catch (e) {
    if (handleProviderError(e, res)) return;
    next(e);
  }
});

router.delete("/:provider", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await disconnectIntegration(
      ctx,
      String(req.params.provider),
    );
    res.json(ok(result));
  } catch (e) {
    if (handleProviderError(e, res)) return;
    next(e);
  }
});

router.post("/:provider/test", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await testIntegration(ctx, String(req.params.provider));
    res.json(ok(row));
  } catch (e) {
    if (e instanceof IntegrationNotConnectedError) {
      res.status(409).json(err("NOT_CONNECTED", e.message));
      return;
    }
    if (handleProviderError(e, res)) return;
    next(e);
  }
});

router.post("/:provider/oauth/start", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = OAuthStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid OAuth start payload"));
      return;
    }
    const result = buildOAuthStart(
      ctx,
      String(req.params.provider),
      parsed.data.redirectUri,
    );
    res.json(ok(result));
  } catch (e) {
    if (handleProviderError(e, res)) return;
    next(e);
  }
});

router.post("/:provider/oauth/callback", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = OAuthCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid OAuth callback payload"));
      return;
    }
    const row = await completeOAuthCallback(
      ctx,
      String(req.params.provider),
      parsed.data,
    );
    res.json(ok(row));
  } catch (e) {
    if (handleProviderError(e, res)) return;
    next(e);
  }
});

router.post("/:provider/actions/:action", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid action payload"));
      return;
    }
    const result = await executeIntegrationAction(
      ctx,
      String(req.params.provider),
      String(req.params.action),
      parsed.data.input ?? {},
    );
    res.json(ok(result));
  } catch (e) {
    if (e instanceof UnknownActionError) {
      res.status(404).json(err("NOT_FOUND", e.message));
      return;
    }
    if (e instanceof IntegrationNotConnectedError) {
      res.status(409).json(err("NOT_CONNECTED", e.message));
      return;
    }
    if (handleProviderError(e, res)) return;
    next(e);
  }
});

export default router;
