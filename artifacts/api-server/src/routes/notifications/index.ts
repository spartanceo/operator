/**
 * /api/notifications — in-app notification centre + OS dispatch hook.
 *
 * Routes:
 *   GET    /                    paginated list (newest first).
 *   GET    /unread-count        bell-badge count.
 *   POST   /                    create a notification (used by upstream services).
 *   POST   /:id/read            mark one as read.
 *   POST   /read-all            mark every unread as read.
 *   POST   /clear               delete every notification (with confirmation).
 *   GET    /preferences         per-category preference matrix.
 *   PUT    /preferences         update preferences.
 *   POST   /dispatch-claim      Electron main process claim hook.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  claimUndispatchedNotifications,
  clearAllNotifications,
  createNotification,
  getNotificationPreferences,
  getUnreadCount,
  listNotifications,
  markAllRead,
  markNotificationRead,
  updateNotificationPreferences,
  type NotificationCategory,
} from "../../services/notifications.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  unreadOnly: z.coerce.boolean().optional(),
});

const CategorySchema = z.enum([
  "task",
  "approval",
  "skill",
  "error",
  "system",
]);

const SeveritySchema = z.enum(["info", "success", "warning", "error"]);

const CreateSchema = z.object({
  category: CategorySchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  severity: SeveritySchema.optional(),
  actionLabel: z.string().max(80).optional(),
  actionHref: z.string().max(2048).optional(),
  relatedRunId: z.string().max(120).optional(),
  relatedApprovalId: z.string().max(120).optional(),
});

const PreferenceEntrySchema = z.object({
  inApp: z.boolean(),
  os: z.boolean(),
});

const PreferencesSchema = z.object({
  task: PreferenceEntrySchema.optional(),
  approval: PreferenceEntrySchema.optional(),
  skill: PreferenceEntrySchema.optional(),
  error: PreferenceEntrySchema.optional(),
  system: PreferenceEntrySchema.optional(),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listNotifications(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/unread-count", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const value = await getUnreadCount(ctx);
    res.json(ok({ count: value }));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid notification payload"));
      return;
    }
    const row = await createNotification(ctx, parsed.data);
    res.json(ok({ notification: row }));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/read", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const updated = await markNotificationRead(ctx, String(req.params.id));
    if (!updated) {
      res.status(404).json(err("NOT_FOUND", "Notification not found"));
      return;
    }
    res.json(ok(updated));
  } catch (e) {
    next(e);
  }
});

router.post("/read-all", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await markAllRead(ctx);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/clear", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await clearAllNotifications(ctx);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/preferences", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const prefs = await getNotificationPreferences(ctx);
    res.json(ok({ preferences: prefs }));
  } catch (e) {
    next(e);
  }
});

router.put("/preferences", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid preferences payload"));
      return;
    }
    const updated = await updateNotificationPreferences(
      ctx,
      parsed.data as Partial<Record<NotificationCategory, { inApp: boolean; os: boolean }>>,
    );
    res.json(ok({ preferences: updated }));
  } catch (e) {
    next(e);
  }
});

router.post("/dispatch-claim", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const rows = await claimUndispatchedNotifications(ctx);
    res.json(ok({ items: rows }));
  } catch (e) {
    next(e);
  }
});

export default router;
