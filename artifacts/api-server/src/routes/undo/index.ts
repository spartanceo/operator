/**
 * /api/undo — undo stack for desktop / file actions (Task #44).
 *
 * Endpoints:
 *   GET    /actions                  — paginated undo history.
 *   GET    /actions/:id              — singleton lookup.
 *   POST   /actions/:id/undo         — reverse one action.
 *   POST   /tasks/:taskId/undo       — reverse every action in a task.
 *   GET    /tasks/:taskId/actions    — list actions belonging to a task.
 *   GET    /irreversible-types       — fixed set of action types that
 *                                      cannot be undone (frontend uses
 *                                      this to render the warning copy).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  getAction,
  IrreversibleActionError,
  IRREVERSIBLE_ACTION_TYPES,
  listActions,
  REVERSIBLE_ACTION_TYPES,
  undoAction,
  undoTask,
  UndoExpiredError,
  UndoFailedError,
} from "../../services/undo.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  taskId: z.string().min(1).max(200).optional(),
});

function handleUndoError(e: unknown, res: Parameters<Parameters<IRouter["post"]>[1]>[1]) {
  if (e instanceof IrreversibleActionError) {
    res.status(409).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof UndoExpiredError) {
    res.status(410).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof UndoFailedError) {
    res.status(409).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/actions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid undo list params"));
      return;
    }
    const page = await listActions(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/actions/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getAction(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Undo action not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/actions/:id/undo", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await undoAction(ctx, String(req.params.id));
    res.json(ok(row));
  } catch (e) {
    if (handleUndoError(e, res)) return;
    next(e);
  }
});

const TaskUndoSchema = z.object({
  confirm: z.literal(true, {
    errorMap: () => ({
      message: "Confirm flag is required when reversing an entire task",
    }),
  }),
});

router.post("/tasks/:taskId/undo", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = TaskUndoSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(409)
        .json(
          err(
            "CONFIRM_REQUIRED",
            "Reversing an entire task requires explicit confirmation",
          ),
        );
      return;
    }
    const result = await undoTask(ctx, String(req.params.taskId));
    res.json(ok(result));
  } catch (e) {
    if (handleUndoError(e, res)) return;
    next(e);
  }
});

router.get("/tasks/:taskId/actions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid undo list params"));
      return;
    }
    const page = await listActions(ctx, {
      ...parsed.data,
      taskId: String(req.params.taskId),
    });
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/irreversible-types", requireTenant(), async (_req, res, next) => {
  try {
    res.json(
      ok({
        reversible: [...REVERSIBLE_ACTION_TYPES],
        irreversible: [...IRREVERSIBLE_ACTION_TYPES],
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
