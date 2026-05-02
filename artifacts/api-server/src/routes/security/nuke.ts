/**
 * /api/security/nuke — wipe every local trace of the tenant.
 *
 * Belt-and-braces:
 *   - explicit `confirm: "DELETE EVERYTHING"` literal in the body
 *   - master password verified (rate-limited via authLimiter)
 *   - additional adminLimiter so even a leaked password can't loop here
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { authLimiter } from "../../middlewares/auth-rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import { nukeTenantData } from "../../services/data-nuke.service";
import {
  getMasterPasswordStatus,
  verifyMasterPassword,
} from "../../services/master-password.service";

const router: IRouter = Router();

const NukeSchema = z.object({
  confirm: z.literal("DELETE EVERYTHING"),
  masterPassword: z.string().min(1).max(256),
  reason: z.string().max(500).optional(),
});

router.post(
  "/nuke",
  adminLimiter,
  authLimiter,
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = NukeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid nuke payload"));
        return;
      }
      const status = await getMasterPasswordStatus(ctx);
      if (status.isSet) {
        const verify = await verifyMasterPassword(ctx, parsed.data.masterPassword);
        if (!verify.success) {
          res
            .status(401)
            .json(err("INVALID_MASTER_PASSWORD", "Master password is incorrect"));
          return;
        }
      }
      const result = await nukeTenantData(ctx, parsed.data.reason ?? "");
      res.json(ok(result));
    } catch (e) {
      next(e);
    }
  },
);

export default router;
