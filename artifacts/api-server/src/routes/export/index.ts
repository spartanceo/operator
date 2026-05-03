/**
 * /api/export — data-portability surface (Task #20).
 *
 * These endpoints produce per-domain, human-portable exports separately
 * from the encrypted full-tenant snapshot served by /api/backup/create.
 * Use case: "I want to copy my conversation history into Notion" or
 * "I want to share my memories JSON with my coach" — that's an unencrypted,
 * scoped artefact, not a full machine-restore archive.
 *
 * Routes:
 *   GET /conversations  Markdown or JSON of every agent run + messages
 *   GET /memories       Memory rows, sorted by importance
 *   GET /settings       Onboarding profile + model preferences + backup config
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  conversationsToMarkdown,
  exportConversations,
  exportMemories,
  exportSettings,
} from "../../services/backup.service";

const router: IRouter = Router();

const FormatSchema = z.object({
  format: z.enum(["json", "markdown"]).optional(),
});

router.get("/conversations", adminLimiter, requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = FormatSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid format param"));
      return;
    }
    const entries = await exportConversations(ctx);
    if (parsed.data.format === "markdown") {
      res.json(
        ok({
          format: "markdown",
          exportedAt: new Date().toISOString(),
          markdown: conversationsToMarkdown(entries),
          conversationCount: entries.length,
        }),
      );
      return;
    }
    res.json(
      ok({
        format: "json",
        exportedAt: new Date().toISOString(),
        conversations: entries,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/memories", adminLimiter, requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const memories = await exportMemories(ctx);
    res.json(
      ok({
        exportedAt: new Date().toISOString(),
        memories,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/settings", adminLimiter, requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const settings = await exportSettings(ctx);
    res.json(ok(settings));
  } catch (e) {
    next(e);
  }
});

export default router;
