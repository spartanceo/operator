/**
 * /api/support — customer support tickets, conversation log, response
 * templates, and the OP team support dashboard (Task #34).
 *
 * Tenant-scoped reads/writes for end users; the dashboard + cross-tenant
 * read paths under `/dashboard` and `/admin/tickets` deliberately bypass
 * tenant scoping (those are OP-team-only surfaces protected by network
 * placement, the same as the rest of `/admin/super`).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  appendTicketMessage,
  buildDiagnosticBundle,
  createTicket,
  deleteResponseTemplate,
  getSupportDashboardMetrics,
  getTicket,
  listAllTicketsForOpTeam,
  listResponseTemplates,
  listTicketEvents,
  listTickets,
  SupportValidationError,
  updateTicketStatus,
  upsertResponseTemplate,
} from "../../services/support.service";

const router: IRouter = Router();

const CreateTicketSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  userEmail: z.string().email(),
  userLabel: z.string().max(120).optional(),
  category: z.string().max(40).optional(),
  priority: z.string().max(20).optional(),
  opVersion: z.string().max(40).optional(),
  osInfo: z.string().max(80).optional(),
  hardwareTier: z.string().max(20).optional(),
  attachmentNote: z.string().max(500).optional(),
});

const AppendMessageSchema = z.object({
  body: z.string().min(1).max(8000),
  sender: z.enum(["user", "op", "system"]).optional(),
  senderLabel: z.string().max(120).optional(),
});

const UpdateStatusSchema = z.object({
  status: z.string().min(1).max(40),
  resolutionNotes: z.string().max(4000).optional(),
  assigneeLabel: z.string().max(120).optional(),
});

const TemplateSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(120),
  body: z.string().min(1).max(8000),
  category: z.string().max(40).optional(),
});

const DiagnosticSchema = z.object({
  opVersion: z.string().max(40).optional(),
  osInfo: z.string().max(80).optional(),
  hardwareTier: z.string().max(20).optional(),
});

function handleErr(e: unknown, res: import("express").Response): boolean {
  if (e instanceof SupportValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.post("/tickets", requireTenant(), async (req, res, next) => {
  try {
    const parsed = CreateTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid ticket payload"));
      return;
    }
    const ctx = requireTenantContext();
    const ticket = await createTicket(ctx, parsed.data);
    res.json(ok({ ticket }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.get("/tickets", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const status =
      typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    const cursor =
      typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined;
    const limit =
      typeof req.query["limit"] === "string"
        ? Number(req.query["limit"])
        : undefined;
    const page = await listTickets(ctx, { status, cursor, limit });
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/tickets/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const ticket = await getTicket(ctx, String(req.params["id"]));
    if (!ticket) {
      res.status(404).json(err("NOT_FOUND", "Ticket not found"));
      return;
    }
    const events = await listTicketEvents(ctx, ticket.id);
    res.json(ok({ ticket, events }));
  } catch (e) {
    next(e);
  }
});

router.post(
  "/tickets/:id/messages",
  requireTenant(),
  async (req, res, next) => {
    try {
      const parsed = AppendMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(err("VALIDATION", "Invalid message payload"));
        return;
      }
      const ctx = requireTenantContext();
      const event = await appendTicketMessage(ctx, {
        ticketId: String(req.params["id"]),
        ...parsed.data,
      });
      res.json(ok({ event }));
    } catch (e) {
      if (handleErr(e, res)) return;
      next(e);
    }
  },
);

router.post("/tickets/:id/status", requireTenant(), async (req, res, next) => {
  try {
    const parsed = UpdateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid status payload"));
      return;
    }
    const ctx = requireTenantContext();
    const ticket = await updateTicketStatus(ctx, {
      ticketId: String(req.params["id"]),
      ...parsed.data,
    });
    res.json(ok({ ticket }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.post("/diagnostics", requireTenant(), async (req, res, next) => {
  try {
    const parsed = DiagnosticSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid diagnostics payload"));
      return;
    }
    const ctx = requireTenantContext();
    const bundle = await buildDiagnosticBundle(ctx, parsed.data);
    res.json(ok({ bundle }));
  } catch (e) {
    next(e);
  }
});

// ─── Response templates ──────────────────────────────────────────────────────

router.get("/templates", async (_req, res, next) => {
  try {
    const items = await listResponseTemplates();
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.put("/templates", async (req, res, next) => {
  try {
    const parsed = TemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid template payload"));
      return;
    }
    const template = await upsertResponseTemplate(parsed.data);
    res.json(ok({ template }));
  } catch (e) {
    if (handleErr(e, res)) return;
    next(e);
  }
});

router.delete("/templates/:id", async (req, res, next) => {
  try {
    await deleteResponseTemplate(String(req.params["id"]));
    res.json(ok({ deleted: true }));
  } catch (e) {
    next(e);
  }
});

// ─── OP team dashboard (cross-tenant) ────────────────────────────────────────

router.get("/dashboard", async (_req, res, next) => {
  try {
    const metrics = await getSupportDashboardMetrics();
    res.json(ok(metrics));
  } catch (e) {
    next(e);
  }
});

router.get("/admin/tickets", async (req, res, next) => {
  try {
    const status =
      typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    const cursor =
      typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined;
    const limit =
      typeof req.query["limit"] === "string"
        ? Number(req.query["limit"])
        : undefined;
    const page = await listAllTicketsForOpTeam({ status, cursor, limit });
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

export default router;
