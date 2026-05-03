/**
 * /api/tasks — multi-task queue & concurrent task management (Task #38).
 *
 * Endpoints:
 *   POST   /                  — enqueue a new task.
 *   GET    /                  — paginated list of every task.
 *   GET    /snapshot          — active + queued + recently-completed snapshot.
 *   POST   /clear             — cancel every still-queued task.
 *   GET    /:id               — singleton lookup.
 *   POST   /:id/cancel        — cancel a queued / running task.
 *   POST   /:id/priority      — change a queued task's priority.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  cancelTask,
  clearQueue,
  enqueueTask,
  getQueueSnapshot,
  getTask,
  listTasks,
  setPriority,
  type TaskPriority,
  type TaskStatus,
} from "../../services/task-queue.service";

const router: IRouter = Router();

const PrioritySchema = z.enum(["high", "normal", "low"]);
const StatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "stale",
]);

const EnqueueSchema = z.object({
  goal: z.string().min(1).max(4000),
  modelName: z.string().min(1).max(200).optional(),
  useKnowledgeBase: z.boolean().optional(),
  knowledgeCollectionId: z.string().min(1).max(120).optional(),
  priority: PrioritySchema.optional(),
  contextSnapshot: z.record(z.string(), z.unknown()).optional(),
});

const ListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  status: StatusSchema.optional(),
});

const SetPrioritySchema = z.object({
  priority: PrioritySchema,
});

const ClearSchema = z.object({
  confirm: z.boolean(),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid task-list params"));
      return;
    }
    const opts: { cursor?: string; limit?: number; status?: TaskStatus } = {};
    if (parsed.data.cursor) opts.cursor = parsed.data.cursor;
    if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit;
    if (parsed.data.status) opts.status = parsed.data.status;
    const page = await listTasks(ctx, opts);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = EnqueueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid enqueue payload"));
      return;
    }
    const input: Parameters<typeof enqueueTask>[1] = { goal: parsed.data.goal };
    if (parsed.data.modelName) input.modelName = parsed.data.modelName;
    if (parsed.data.useKnowledgeBase !== undefined) {
      input.useKnowledgeBase = parsed.data.useKnowledgeBase;
    }
    if (parsed.data.knowledgeCollectionId) {
      input.knowledgeCollectionId = parsed.data.knowledgeCollectionId;
    }
    if (parsed.data.priority) input.priority = parsed.data.priority;
    if (parsed.data.contextSnapshot) {
      input.contextSnapshot = parsed.data.contextSnapshot;
    }
    const row = await enqueueTask(ctx, input);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/snapshot", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const snap = await getQueueSnapshot(ctx);
    res.json(ok(snap));
  } catch (e) {
    next(e);
  }
});

router.post("/clear", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ClearSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.confirm) {
      res
        .status(400)
        .json(err("VALIDATION", "Confirmation required to clear the queue"));
      return;
    }
    const result = await clearQueue(ctx);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getTask(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Task not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/cancel", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await cancelTask(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Task not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/priority", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SetPrioritySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid priority payload"));
      return;
    }
    const row = await setPriority(
      ctx,
      String(req.params.id),
      parsed.data.priority as TaskPriority,
    );
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Task not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

export default router;
