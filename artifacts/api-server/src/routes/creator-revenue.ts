/**
 * /api/creator — creator revenue dashboard endpoints (Task #6).
 *
 * Authenticates by API token (handed out at signup, hashed in
 * `creator_accounts.api_token_hash`) so the same /creator/earnings call
 * works from both the marketing site and the operator app.
 */
import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { creatorAccounts, db, tenantScope } from "@workspace/db";

import { err, ok } from "../lib/api-envelope";
import { requireTenantContext } from "../lib/tenant-context";
import { requireTenant } from "../middlewares/tenant-context";
import { getCreatorEarnings } from "../services/subscription.service";

const router: IRouter = Router();

const EarningsSchema = z.object({ apiToken: z.string().min(1).max(200) });

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

router.post("/earnings", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = EarningsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Missing apiToken"));
      return;
    }
    const tokenHash = hashToken(parsed.data.apiToken);
    const rows = await db
      .select()
      .from(creatorAccounts)
      .where(and(tenantScope(ctx, creatorAccounts), eq(creatorAccounts.apiTokenHash, tokenHash)))
      .limit(1);
    if (!rows[0]) {
      res.status(401).json(err("CREATOR_AUTH", "Invalid creator API token"));
      return;
    }
    const earnings = await getCreatorEarnings(ctx, rows[0].handle);
    res.json(
      ok({
        creator: { handle: rows[0].handle, displayName: rows[0].displayName },
        ...earnings,
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
