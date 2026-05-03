/**
 * /api/orchestrations — multi-agent DAG orchestration (Task #50).
 *
 * Endpoints:
 *   POST   /decompose                      — preview a DAG without running it
 *   POST   /                               — create + start an orchestration
 *   GET    /                               — paginated list
 *   GET    /agents                         — list built-in specialised agents
 *   GET    /:id                            — orchestration + nodes (timeline)
 *   GET    /:id/trace                      — "how was this done?" view
 *   POST   /:id/cancel                     — cancel an in-flight orchestration
 *   POST   /:id/nodes/:nodeKey/decide      — resolve an approval gate
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  cancelOrchestration,
  createOrchestration,
  decideOrchestrationApproval,
  decomposeGoal,
  getOrchestration,
  getOrchestrationTrace,
  listBuiltInAgents,
  listOrchestrations,
  OrchestrationDagInvalidError,
  OrchestrationDepthExceededError,
} from "../../services/orchestrator.service";

const router: IRouter = Router();

const CreateSchema = z.object({
  goal: z.string().min(1).max(4000),
  conversationId: z.string().min(1).max(120).optional(),
  parentOrchestrationId: z.string().min(1).max(120).optional(),
});

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const DecomposeSchema = z.object({
  goal: z.string().min(1).max(4000),
});

const DecideSchema = z.object({
  decision: z.enum(["approved", "denied"]),
});

router.get("/agents", requireTenant(), (_req, res) => {
  res.json(ok({ agents: listBuiltInAgents() }));
});

router.post("/decompose", requireTenant(), (req, res, next) => {
  try {
    const parsed = DecomposeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid decompose payload"));
      return;
    }
    const plan = decomposeGoal(parsed.data.goal);
    res.json(ok(plan));
  } catch (e) {
    if (e instanceof OrchestrationDagInvalidError) {
      res.status(400).json(err("DAG_INVALID", e.message));
      return;
    }
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
    const page = await listOrchestrations(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid orchestration payload"));
      return;
    }
    const input: Parameters<typeof createOrchestration>[1] = {
      goal: parsed.data.goal,
    };
    if (parsed.data.conversationId) input.conversationId = parsed.data.conversationId;
    if (parsed.data.parentOrchestrationId) {
      input.parentOrchestrationId = parsed.data.parentOrchestrationId;
    }
    const row = await createOrchestration(ctx, input);
    res.json(ok(row));
  } catch (e) {
    if (e instanceof OrchestrationDepthExceededError) {
      res
        .status(400)
        .json(err("DEPTH_EXCEEDED", e.message, { depth: e.depth }));
      return;
    }
    if (e instanceof OrchestrationDagInvalidError) {
      res.status(400).json(err("DAG_INVALID", e.message));
      return;
    }
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getOrchestration(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Orchestration not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/trace", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const trace = await getOrchestrationTrace(ctx, String(req.params.id));
    if (!trace) {
      res.status(404).json(err("NOT_FOUND", "Orchestration not found"));
      return;
    }
    res.json(ok(trace));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/cancel", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await cancelOrchestration(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Orchestration not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post(
  "/:id/nodes/:nodeKey/decide",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const parsed = DecideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid decision payload"));
        return;
      }
      const node = await decideOrchestrationApproval(
        ctx,
        String(req.params.id),
        String(req.params.nodeKey),
        parsed.data,
      );
      if (!node) {
        res.status(404).json(err("NOT_FOUND", "Node not found"));
        return;
      }
      res.json(ok(node));
    } catch (e) {
      next(e);
    }
  },
);

export default router;
