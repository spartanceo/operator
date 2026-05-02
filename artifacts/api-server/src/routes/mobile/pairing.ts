/**
 * /api/mobile/pairing — generate and claim QR pairing codes.
 *
 * `POST /` is called by the desktop OP settings panel to mint a fresh
 * code; `POST /claim` is called by the PWA after scanning the QR.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  PairingError,
  claimPairing,
  startPairing,
} from "../../services/mobile/pairing.service";

const router: IRouter = Router();

const ClaimSchema = z.object({
  code: z.string().min(4).max(64),
  relayToken: z.string().min(8).max(200),
  label: z.string().min(1).max(200),
  platform: z.enum(["ios", "android", "web"]).default("web"),
  userAgent: z.string().min(1).max(500).optional(),
});

router.post("/", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const token = await startPairing(ctx);
    res.json(ok(token));
  } catch (e) {
    next(e);
  }
});

router.post("/claim", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pairing payload"));
      return;
    }
    const result = await claimPairing(
      ctx,
      {
        code: parsed.data.code,
        label: parsed.data.label,
        platform: parsed.data.platform,
        ...(parsed.data.userAgent ? { userAgent: parsed.data.userAgent } : {}),
      },
      parsed.data.relayToken,
    );
    res.json(ok(result));
  } catch (e) {
    if (e instanceof PairingError) {
      res.status(400).json(err("PAIRING_FAILED", e.message));
      return;
    }
    next(e);
  }
});

export default router;
