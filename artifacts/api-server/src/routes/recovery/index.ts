/**
 * /api/recovery — crash recovery & mid-task resumption (Task #58).
 *
 * Endpoints:
 *   GET  /interrupted          — every running task without a matching shutdown.
 *   GET  /:taskId              — full recovery details (history + validation).
 *   POST /:taskId/resume       — re-queue an interrupted task.
 *   POST /:taskId/discard      — mark failed; optionally reverse destructive steps.
 *   POST /:taskId/partial-undo — reverse reversible destructive steps without discarding.
 *   POST /shutdown             — manually record a clean shutdown (used by quit hooks).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  CheckpointInvalidError,
  discardTask,
  findInterruptedTasks,
  getRecoveryDetails,
  partialUndoBeforeResume,
  recordCleanShutdown,
  resumeTask,
} from "../../services/crash-recovery.service";

const router: IRouter = Router();

const DiscardSchema = z.object({
  partialUndo: z.boolean().optional(),
  confirm: z.boolean(),
});

const ShutdownSchema = z.object({
  reason: z.enum(["normal", "user_quit", "system_restart", "test"]).optional(),
});

router.get("/interrupted", async (_req, res, next) => {
  try {
    const items = await findInterruptedTasks();
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.get("/:taskId", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const details = await getRecoveryDetails(ctx, String(req.params.taskId));
    if (!details) {
      res.status(404).json(err("NOT_FOUND", "Task not found"));
      return;
    }
    res.json(ok(details));
  } catch (e) {
    next(e);
  }
});

router.post("/:taskId/resume", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await resumeTask(ctx, String(req.params.taskId));
    res.json(ok(result));
  } catch (e) {
    if (e instanceof CheckpointInvalidError) {
      res.status(409).json(err(e.code, e.message, { ...e.report }));
      return;
    }
    next(e);
  }
});

router.post("/:taskId/discard", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = DiscardSchema.safeParse(req.body ?? {});
    if (!parsed.success || !parsed.data.confirm) {
      res
        .status(400)
        .json(err("VALIDATION", "Confirmation required to discard a task"));
      return;
    }
    const opts = parsed.data.partialUndo ? { partialUndo: true } : {};
    const result = await discardTask(ctx, String(req.params.taskId), opts);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:taskId/partial-undo", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await partialUndoBeforeResume(ctx, String(req.params.taskId));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/shutdown", async (req, res, next) => {
  try {
    const parsed = ShutdownSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid shutdown payload"));
      return;
    }
    const input = parsed.data.reason ? { reason: parsed.data.reason } : {};
    const result = await recordCleanShutdown(input);
    res.json(
      ok({
        id: result.id,
        shutdownAt: new Date(result.shutdownAt).toISOString(),
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
