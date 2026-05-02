/**
 * /api/agent — deterministic agent loop API surface.
 *
 * Endpoints:
 *   POST   /runs                         — kick off a new run.
 *   GET    /runs                         — list paginated runs.
 *   GET    /runs/:id                     — singleton run lookup.
 *   POST   /runs/:id/cancel              — cancel a running run.
 *   GET    /runs/:id/messages            — paginated transcript.
 *   GET    /runs/:id/tool-calls          — paginated tool-call audit.
 *   GET    /runs/:id/approvals           — paginated approvals list.
 *   POST   /approvals/:id/decide         — resolve a pending gate.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  cancelAgentRun,
  createAgentRun,
  getAgentRun,
  listAgentRuns,
  listRunMessages,
  listRunToolCalls,
} from "../../services/agent.service";
import {
  batchDecideApprovals,
  decideApproval,
  listApprovals,
  listApprovalsForRun,
} from "../../services/approvals.service";

const router: IRouter = Router();

const CreateRunSchema = z.object({
  goal: z.string().min(1).max(4000),
  modelName: z.string().min(1).max(200).optional(),
  useKnowledgeBase: z.boolean().optional(),
  knowledgeCollectionId: z.string().min(1).max(120).optional(),
  conversationId: z.string().min(1).max(120).optional(),
});

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const DecisionSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  note: z.string().max(2000).optional(),
});

const ApprovalListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  decision: z.enum(["pending", "approved", "denied"]).optional(),
});

const BatchDecideSchema = z.object({
  ids: z.array(z.string().min(1).max(120)).min(1).max(50),
  decision: z.enum(["approved", "denied"]),
  note: z.string().max(2000).optional(),
});

router.get("/runs", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listAgentRuns(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/runs", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid agent-run payload"));
      return;
    }
    const run = await createAgentRun(ctx, parsed.data);
    res.json(ok(run));
  } catch (e) {
    next(e);
  }
});

router.get("/runs/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const run = await getAgentRun(ctx, String(req.params.id));
    if (!run) {
      res.status(404).json(err("NOT_FOUND", "Agent run not found"));
      return;
    }
    res.json(ok(run));
  } catch (e) {
    next(e);
  }
});

router.post("/runs/:id/cancel", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const run = await cancelAgentRun(ctx, String(req.params.id));
    if (!run) {
      res.status(404).json(err("NOT_FOUND", "Agent run not found"));
      return;
    }
    res.json(ok(run));
  } catch (e) {
    next(e);
  }
});

router.get("/runs/:id/messages", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listRunMessages(ctx, String(req.params.id), parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/runs/:id/tool-calls", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listRunToolCalls(ctx, String(req.params.id), parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/runs/:id/approvals", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listApprovalsForRun(ctx, String(req.params.id), parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/approvals", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ApprovalListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid approval-list params"));
      return;
    }
    const page = await listApprovals(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/approvals/decide-batch", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = BatchDecideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid batch-decide payload"));
      return;
    }
    const result = await batchDecideApprovals(ctx, parsed.data);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/approvals/:id/decide", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = DecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid decision payload"));
      return;
    }
    const updated = await decideApproval(ctx, String(req.params.id), parsed.data);
    if (!updated) {
      res.status(404).json(err("NOT_FOUND", "Approval not found"));
      return;
    }
    res.json(ok(updated));
  } catch (e) {
    next(e);
  }
});

export default router;
