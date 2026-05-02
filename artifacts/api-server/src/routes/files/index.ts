/**
 * /api/files — workspace-sandboxed file operations.
 *
 * The service-layer `resolveSandboxedPath` throws `SandboxEscapeError` for
 * traversal / symlink attacks. We translate that to a 400 with a stable
 * `SANDBOX_ESCAPE` code so callers can react.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { SandboxEscapeError } from "../../lib/sandbox";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  deleteFile,
  FileTooLargeError,
  listFiles,
  readFile,
  writeFile,
} from "../../services/files.service";

const router: IRouter = Router();

const ListSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  path: z.string().min(1).max(1024).optional(),
});

const ReadSchema = z.object({ path: z.string().min(1).max(1024) });
const WriteSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(1_048_576),
});
const DeleteSchema = z.object({ path: z.string().min(1).max(1024) });

function handleFileError(e: unknown, res: Parameters<Parameters<IRouter["get"]>[1]>[1]) {
  if (e instanceof SandboxEscapeError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof FileTooLargeError) {
    res.status(413).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/list", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid list params"));
      return;
    }
    const page = await listFiles(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    if (handleFileError(e, res)) return;
    next(e);
  }
});

router.post("/read", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ReadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid read payload"));
      return;
    }
    const result = await readFile(ctx, parsed.data.path);
    res.json(ok(result));
  } catch (e) {
    if (handleFileError(e, res)) return;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json(err("NOT_FOUND", "File not found"));
      return;
    }
    next(e);
  }
});

router.post("/write", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = WriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid write payload"));
      return;
    }
    const result = await writeFile(ctx, parsed.data.path, parsed.data.content);
    res.json(ok(result));
  } catch (e) {
    if (handleFileError(e, res)) return;
    next(e);
  }
});

router.post("/delete", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = DeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid delete payload"));
      return;
    }
    const result = await deleteFile(ctx, parsed.data.path);
    res.json(ok(result));
  } catch (e) {
    if (handleFileError(e, res)) return;
    next(e);
  }
});

export default router;
