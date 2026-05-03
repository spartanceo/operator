/**
 * /api/skills/:id/execute, /:id/run-tests, /:id/manifest, runs/:invocationId/progress
 *
 * Sub-router that wires the Task #39 execution contract to HTTP. Mounted
 * by the parent skills router under `/api/skills`.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  attachExecutionManifest,
  ManifestValidationError,
  runInstalledSkill,
  runSkillTests,
  SkillExecutionNotFoundError,
} from "../../services/skill-execution.service";
import {
  getBacklog,
  subscribeProgress,
} from "../../skill-runtime/progress-bus";

const router: IRouter = Router();

const ExecuteSchema = z.object({
  input: z.unknown().optional(),
  invocationId: z.string().min(8).max(120).optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

function handleExecutionError(e: unknown, res: Response): boolean {
  if (e instanceof SkillExecutionNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof ManifestValidationError) {
    res.status(400).json(err(e.code, e.message, { path: e.path }));
    return true;
  }
  return false;
}

router.post("/:id/execute", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ExecuteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid execute payload"));
      return;
    }
    const result = await runInstalledSkill(ctx, String(req.params["id"]), {
      input: parsed.data.input,
      invocationId: parsed.data.invocationId,
      timeoutMs: parsed.data.timeoutMs,
    });
    res.json(ok(result));
  } catch (e) {
    if (handleExecutionError(e, res)) return;
    next(e);
  }
});

router.post("/:id/run-tests", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const report = await runSkillTests(ctx, String(req.params["id"]));
    res.json(ok(report));
  } catch (e) {
    if (handleExecutionError(e, res)) return;
    next(e);
  }
});

const ManifestSchema = z.object({ manifest: z.unknown() });

router.put("/:id/manifest", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ManifestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid manifest payload"));
      return;
    }
    const manifest = await attachExecutionManifest(
      ctx,
      String(req.params["id"]),
      parsed.data.manifest,
    );
    res.json(ok(manifest));
  } catch (e) {
    if (handleExecutionError(e, res)) return;
    next(e);
  }
});

/**
 * SSE endpoint — subscribes the chat to live progress events for a
 * given invocation id. Replays the backlog buffer first, then tails
 * live events until the invocation publishes its terminal "__end__".
 */
router.get(
  "/runs/:invocationId/progress",
  requireTenant(),
  (req: Request, res: Response) => {
    const invocationId = String(req.params["invocationId"]);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const ctx = requireTenantContext();
    const tenantId = ctx.tenantId;

    const send = (event: { type: string; data: unknown }) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    };

    for (const ev of getBacklog(tenantId, invocationId)) {
      send({ type: "progress", data: ev });
    }

    const unsubscribe = subscribeProgress(tenantId, invocationId, (event) => {
      if (event.message === "__end__") {
        send({ type: "end", data: { invocationId } });
        cleanup();
        return;
      }
      send({ type: "progress", data: event });
    });

    const heartbeat = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 15_000);
    heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    req.on("close", cleanup);
  },
);

export default router;
