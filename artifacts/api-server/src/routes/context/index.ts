/**
 * /api/context — long-document chunking utility.
 *
 * Splits an oversize input into model-fit segments so callers can
 * process them sequentially rather than crashing on context overflow.
 * Pure compute; no database writes.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenant } from "../../middlewares/tenant-context";
import { chunkLongInput, getContextWindowFor } from "../../services/context.service";

const router: IRouter = Router();

const ChunkSchema = z.object({
  text: z.string().min(1).max(2_000_000),
  model: z.string().min(1).max(200).optional(),
  chunkOverlapTokens: z.number().int().min(0).max(2_048).optional(),
});

router.post("/chunk", requireTenant(), async (req, res, next) => {
  try {
    const parsed = ChunkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid chunk payload"));
      return;
    }
    const chunks = chunkLongInput(parsed.data.text, parsed.data.model ?? null, {
      ...(parsed.data.chunkOverlapTokens !== undefined
        ? { chunkOverlapTokens: parsed.data.chunkOverlapTokens }
        : {}),
    });
    res.json(
      ok({
        chunks,
        totalChunks: chunks.length,
        contextWindow: getContextWindowFor(parsed.data.model ?? null),
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
