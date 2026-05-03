/**
 * /api/system-integration — global hotkey, quick-input overlay, menu bar /
 * system tray, right-click "Ask OP" services, focus-mode awareness,
 * and login-item registration (Task #52).
 *
 * The Electron desktop shell calls these endpoints whenever an OS-level
 * surface fires (hotkey pressed, tray dropdown opened, right-click
 * Service invoked, Focus Mode toggled). The web frontend reads the same
 * endpoints to render the settings panel and the tray-status preview.
 *
 * Routes:
 *   GET    /settings            current per-tenant config + live state.
 *   PUT    /settings            update hotkey / tray / right-click prefs.
 *   POST   /hotkey/conflict     report an OS-detected hotkey collision.
 *   PUT    /login-item          set the login-item consent flag.
 *   PUT    /focus-mode          push current macOS Focus / Windows Focus
 *                               Assist state from the Electron shell.
 *   POST   /quick-invocations   record a hotkey / tray / right-click
 *                               invocation and (optionally) enqueue the
 *                               agent task.
 *   GET    /quick-invocations   paginated invocation history.
 *   GET    /tray-status         live menu bar / system tray status snapshot.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  CONTEXT_KINDS,
  FOCUS_MODE_SOURCES,
  getSettings,
  getTrayStatus,
  listQuickInvocations,
  QUICK_INVOCATION_SOURCES,
  QUICK_INVOCATION_SURFACES,
  recordQuickInvocation,
  reportHotkeyConflict,
  setFocusMode,
  setLoginItem,
  TRAY_BADGE_MODES,
  updateSettings,
} from "../../services/system-integration.service";

const router: IRouter = Router();

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const SettingsSchema = z.object({
  hotkeyMac: z.string().min(1).max(120).optional(),
  hotkeyWindows: z.string().min(1).max(120).optional(),
  hotkeyEnabled: z.boolean().optional(),
  trayEnabled: z.boolean().optional(),
  trayBadgeMode: z.enum(TRAY_BADGE_MODES).optional(),
  rightClickMacEnabled: z.boolean().optional(),
  rightClickWindowsEnabled: z.boolean().optional(),
});

const HotkeyConflictSchema = z.object({
  binding: z.string().min(1).max(120),
  detail: z.string().max(500).optional(),
});

const LoginItemSchema = z.object({
  enabled: z.boolean(),
});

const FocusModeSchema = z.object({
  active: z.boolean(),
  source: z.enum(FOCUS_MODE_SOURCES),
});

const QuickInvocationSchema = z.object({
  prompt: z.string().min(1).max(4000),
  source: z.enum(QUICK_INVOCATION_SOURCES),
  surface: z.enum(QUICK_INVOCATION_SURFACES).optional(),
  contextKind: z.enum(CONTEXT_KINDS).optional(),
  contextText: z.string().max(50_000).optional(),
  applicationHint: z.string().max(200).optional(),
  expanded: z.boolean().optional(),
  enqueue: z.boolean().optional(),
});

router.get("/settings", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const settings = await getSettings(ctx);
    res.json(ok({ settings }));
  } catch (e) {
    next(e);
  }
});

router.put("/settings", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid settings payload"));
      return;
    }
    const settings = await updateSettings(ctx, parsed.data);
    res.json(ok({ settings }));
  } catch (e) {
    next(e);
  }
});

router.post("/hotkey/conflict", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = HotkeyConflictSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid hotkey conflict payload"));
      return;
    }
    const settings = await reportHotkeyConflict(ctx, parsed.data);
    res.json(ok({ settings }));
  } catch (e) {
    next(e);
  }
});

router.put("/login-item", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = LoginItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid login item payload"));
      return;
    }
    const settings = await setLoginItem(ctx, parsed.data);
    res.json(ok({ settings }));
  } catch (e) {
    next(e);
  }
});

router.put("/focus-mode", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = FocusModeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid focus mode payload"));
      return;
    }
    const settings = await setFocusMode(ctx, parsed.data);
    res.json(ok({ settings }));
  } catch (e) {
    next(e);
  }
});

router.post("/quick-invocations", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = QuickInvocationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(err("VALIDATION", "Invalid quick invocation payload"));
      return;
    }
    const result = await recordQuickInvocation(ctx, parsed.data);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/quick-invocations", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listQuickInvocations(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/tray-status", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const snapshot = await getTrayStatus(ctx);
    res.json(ok(snapshot));
  } catch (e) {
    next(e);
  }
});

export default router;
