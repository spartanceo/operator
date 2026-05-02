/**
 * /api/security/scan-skill — pre-flight static scan of skill source.
 *
 * Returns the same shape the marketplace-publish flow uses internally,
 * so a skill author can run the scanner against their code locally
 * before submitting.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenant } from "../../middlewares/tenant-context";
import { scanSkillSource } from "../../services/skill-scanner.service";
import { scanForPromptInjection } from "../../services/prompt-injection.service";

const router: IRouter = Router();

const ScanSchema = z.object({
  source: z.string().min(1).max(1_000_000),
  scanInjection: z.boolean().optional(),
});

router.post("/scan-skill", requireTenant(), async (req, res, next) => {
  try {
    const parsed = ScanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid scan payload"));
      return;
    }
    const scan = scanSkillSource(parsed.data.source);
    const injection = parsed.data.scanInjection
      ? scanForPromptInjection(parsed.data.source)
      : null;
    res.json(
      ok({
        scanner: scan,
        injection,
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
