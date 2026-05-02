/**
 * /api/comm/contacts — local CRM contacts and per-contact interaction log.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
} from "../../services/comm/contacts.service";
import { listInteractions } from "../../services/comm/interactions.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const CreateSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().min(3).max(50).optional(),
  company: z.string().min(1).max(200).optional(),
  notes: z.string().max(20_000).optional(),
  followUpAt: z.number().int().positive().optional(),
});

const UpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().min(3).max(50).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  followUpAt: z.number().int().positive().nullable().optional(),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listContacts(ctx, parsed.data);
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
      res.status(400).json(err("VALIDATION", "Invalid contact payload"));
      return;
    }
    const row = await createContact(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getContact(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Contact not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid contact payload"));
      return;
    }
    const row = await updateContact(ctx, String(req.params.id), parsed.data);
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Contact not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteContact(ctx, String(req.params.id));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/interactions", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid query"));
      return;
    }
    const page = await listInteractions(ctx, {
      ...parsed.data,
      contactId: String(req.params.id),
    });
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

export default router;
