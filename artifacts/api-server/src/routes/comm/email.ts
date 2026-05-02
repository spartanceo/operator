/**
 * /api/comm/email — message read/triage and draft compose/send.
 *
 * Send is approval-gated at the service layer: drafts start in
 * `decision = "pending"` and only `POST /drafts/:id/send` flips them
 * through. The API surface mirrors the email service so the agent loop
 * and the Communications Hub UI share one contract.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  categoriseMessage,
  createDraft,
  denyDraft,
  getDraft,
  getMessage,
  ingestMessage,
  listDrafts,
  listMessages,
  sendDraft,
  setMessageStatus,
} from "../../services/comm/email.service";

const router: IRouter = Router();

const ListMessagesSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  accountId: z.string().min(1).max(80).optional(),
  folder: z.enum(["inbox", "sent", "archived", "spam", "trash"]).optional(),
});

const IngestSchema = z.object({
  accountId: z.string().min(1).max(80),
  providerMessageId: z.string().min(1).max(200).optional(),
  threadId: z.string().min(1).max(200).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  fromAddress: z.string().email(),
  toAddresses: z.array(z.string().email()).min(1).max(50),
  subject: z.string().min(1).max(998),
  body: z.string().min(0).max(200_000),
  snippet: z.string().min(1).max(500).optional(),
  folder: z.enum(["inbox", "sent", "archived", "spam", "trash"]).optional(),
  category: z.string().min(1).max(80).optional(),
  receivedAt: z.number().int().positive().optional(),
});

const StatusSchema = z.object({
  status: z.enum(["unread", "read", "replied", "archived"]),
});

const CategorySchema = z.object({
  category: z.string().min(1).max(80),
});

const ListDraftsSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  decision: z.enum(["pending", "approved", "denied", "sent"]).optional(),
});

const CreateDraftSchema = z.object({
  accountId: z.string().min(1).max(80),
  toAddresses: z.array(z.string().email()).min(1).max(50),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(200_000),
  replyToMessageId: z.string().min(1).max(80).optional(),
  sequenceId: z.string().min(1).max(80).optional(),
  enrolmentId: z.string().min(1).max(80).optional(),
});

router.get("/messages", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListMessagesSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listMessages(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/messages", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = IngestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid message payload"));
      return;
    }
    const row = await ingestMessage(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/messages/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getMessage(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Message not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/messages/:id/status", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid status"));
      return;
    }
    const row = await setMessageStatus(ctx, String(req.params.id), parsed.data.status);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Message not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/messages/:id/category", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid category"));
      return;
    }
    const row = await categoriseMessage(
      ctx,
      String(req.params.id),
      parsed.data.category,
    );
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Message not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/drafts", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListDraftsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listDrafts(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/drafts", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid draft payload"));
      return;
    }
    const row = await createDraft(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/drafts/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getDraft(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Draft not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/drafts/:id/send", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const sent = await sendDraft(ctx, String(req.params.id));
    res.json(ok(sent));
  } catch (e) {
    next(e);
  }
});

router.post("/drafts/:id/deny", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await denyDraft(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Draft not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

export default router;
