/**
 * /api/tools — tool catalogue + direct invocation + one-click installer.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  invokeTool,
  listTools,
  ToolNotFoundError,
  ToolValidationError,
} from "../../services/tools.service";
import {
  checkDockerAvailable,
  getInstallState,
  isToolRunning,
  repairContainer,
  resetInstallJob,
  startInstallJob,
  type ToolId,
} from "../../services/tool-installer.service";

const router: IRouter = Router();

const InvokeSchema = z.object({
  input: z.record(z.unknown()),
});

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// tier-review: bounded — fixed 2-element set; new tools require explicit additions here and in the installer service.
const VALID_TOOL_IDS: ReadonlySet<string> = new Set(["searxng", "comfyui"]);

function assertToolId(id: string): asserts id is ToolId {
  if (!VALID_TOOL_IDS.has(id)) {
    throw Object.assign(new Error(`Unknown installable tool: "${id}"`), {
      code: "UNKNOWN_TOOL",
    });
  }
}

// ─── Existing routes ─────────────────────────────────────────────────────────

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listTools(parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/:name/invoke", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InvokeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid invoke payload"));
      return;
    }
    const result = await invokeTool(ctx, String(req.params.name), parsed.data.input);
    res.json(ok(result));
  } catch (e) {
    if (e instanceof ToolNotFoundError) {
      res.status(404).json(err(e.code, e.message));
      return;
    }
    if (e instanceof ToolValidationError) {
      res.status(400).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

// ─── Docker availability check ────────────────────────────────────────────────
//
// GET /api/tools/docker-status
// Returns { available, version } so the frontend can show a friendly
// "Docker is required — download it here" banner when Docker is missing
// for Docker-dependent tools (SearXNG). Does not require tenant auth since
// Docker availability is a host-level property.

router.get("/docker-status", async (_req, res, next) => {
  try {
    const status = await checkDockerAvailable();
    res.json(ok(status));
  } catch (e) {
    next(e);
  }
});

// ─── One-click installer ──────────────────────────────────────────────────────
//
// POST /api/tools/install/:tool   — start (or re-attach to) an install job
// GET  /api/tools/install/:tool/status — poll current status
// POST /api/tools/install/:tool/reset  — clear a failed job so user can retry
//
// All install routes are tenant-scoped: install state is keyed by
// (tenantId, toolId) so one tenant cannot observe or reset another's job.

router.post("/install/:tool", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const toolId = String(req.params.tool);
    assertToolId(toolId);
    const state = startInstallJob(ctx.tenantId, toolId);
    res.status(202).json(ok(state));
  } catch (e) {
    if ((e as { code?: string }).code === "UNKNOWN_TOOL") {
      res.status(400).json(err("UNKNOWN_TOOL", (e as Error).message));
      return;
    }
    next(e);
  }
});

router.get("/install/:tool/status", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const toolId = String(req.params.tool);
    assertToolId(toolId);
    const state = getInstallState(ctx.tenantId, toolId);

    // If idle (never started), also check whether the tool is already
    // running so the frontend shows "Already connected" without requiring
    // the user to click Install first.
    if (state.phase === "idle") {
      const running = await isToolRunning(toolId);
      if (running) {
        res.json(
          ok({
            ...state,
            phase: "ready" as const,
            message: "Already running — connected.",
          }),
        );
        return;
      }
    }

    res.json(ok(state));
  } catch (e) {
    if ((e as { code?: string }).code === "UNKNOWN_TOOL") {
      res.status(400).json(err("UNKNOWN_TOOL", (e as Error).message));
      return;
    }
    next(e);
  }
});

router.post("/install/:tool/reset", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const toolId = String(req.params.tool);
    assertToolId(toolId);
    const state = resetInstallJob(ctx.tenantId, toolId);
    res.json(ok(state));
  } catch (e) {
    if ((e as { code?: string }).code === "UNKNOWN_TOOL") {
      res.status(400).json(err("UNKNOWN_TOOL", (e as Error).message));
      return;
    }
    next(e);
  }
});

// ─── Repair ───────────────────────────────────────────────────────────────────
//
// POST /api/tools/install/:tool/repair
// Force-removes the existing container and re-installs with the correct
// settings (e.g. JSON format enabled for SearXNG). Returns immediately;
// the repair runs in the background — clients should poll /status.

router.post("/install/:tool/repair", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const toolId = String(req.params.tool);
    assertToolId(toolId);
    const state = repairContainer(ctx.tenantId, toolId);
    res.status(202).json(ok(state));
  } catch (e) {
    if ((e as { code?: string }).code === "UNKNOWN_TOOL") {
      res.status(400).json(err("UNKNOWN_TOOL", (e as Error).message));
      return;
    }
    next(e);
  }
});

export default router;
