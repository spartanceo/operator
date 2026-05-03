/**
 * Workspace-sandboxed file operations.
 *
 * Every public function here:
 *   1. Resolves the user-supplied path through `resolveSandboxedPath`,
 *      which throws `SandboxEscapeError` for traversal / symlink attacks.
 *   2. Logs a `file.<op>` privacy event so the audit trail is complete.
 *   3. Returns a stable shape that mirrors the OpenAPI envelope.
 *
 * Tier 1 safety budget: file size cap of 1 MB on read AND write so a
 * runaway prompt cannot drain memory. The Resource Governor task tightens
 * this further per-tenant.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildPage,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { resolveSandboxedPath, workspaceRoot } from "../lib/sandbox";
import { logPrivacyEvent } from "./privacy.service";
import { recordAction } from "./undo.service";

const MAX_BYTES = 1024 * 1024;

export interface FileEntry {
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string | null;
}

export interface FileReadResult {
  path: string;
  content: string;
  size: number;
}

export interface FileWriteResult {
  path: string;
  size: number;
}

export interface FileDeleteResult {
  path: string;
  deleted: boolean;
}

export class FileTooLargeError extends Error {
  override readonly name = "FileTooLargeError";
  readonly code = "FILE_TOO_LARGE";
  constructor(message: string) {
    super(message);
  }
}

export async function listFiles(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; path?: string } = {},
): Promise<PaginatedData<FileEntry>> {
  const limit = normaliseLimit(opts.limit);
  const subDir = opts.path && opts.path.length > 0 ? opts.path : ".";
  const root = workspaceRoot(ctx);
  let dir: string;
  try {
    dir = resolveSandboxedPath(ctx, subDir);
  } catch {
    return { items: [], nextCursor: null };
  }
  let entries: Array<{ name: string; isDir: boolean }> = [];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return { items: [], nextCursor: null };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const cursorName = opts.cursor ? decodeCursor(opts.cursor) : null;
  const startIdx = cursorName
    ? entries.findIndex((e) => e.name > cursorName)
    : 0;
  const sliced = startIdx === -1 ? [] : entries.slice(startIdx);

  const enriched: FileEntry[] = await Promise.all(
    sliced.slice(0, limit + 1).map(async (e) => {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      try {
        const st = await fs.stat(abs);
        return {
          path: rel,
          kind: e.isDir ? "directory" : "file",
          size: e.isDir ? 0 : st.size,
          modifiedAt: st.mtime.toISOString(),
        };
      } catch {
        return {
          path: rel,
          kind: e.isDir ? "directory" : "file",
          size: 0,
          modifiedAt: null,
        };
      }
    }),
  );
  return buildPage(enriched, limit, (r) => path.basename(r.path));
}

export async function readFile(
  ctx: TenantContext,
  filePath: string,
): Promise<FileReadResult> {
  const abs = resolveSandboxedPath(ctx, filePath);
  const stat = await fs.stat(abs);
  if (stat.size > MAX_BYTES) {
    throw new FileTooLargeError(`File "${filePath}" exceeds the ${MAX_BYTES}-byte read limit`);
  }
  const content = await fs.readFile(abs, "utf8");
  await logPrivacyEvent(ctx, {
    eventType: "file.read",
    actor: ctx.userId ?? ctx.tenantId,
    target: filePath,
    severity: "info",
  });
  return { path: filePath, content, size: stat.size };
}

export async function writeFile(
  ctx: TenantContext,
  filePath: string,
  content: string,
  opts: { taskId?: string | null } = {},
): Promise<FileWriteResult> {
  const buf = Buffer.from(content, "utf8");
  if (buf.byteLength > MAX_BYTES) {
    throw new FileTooLargeError(`Content exceeds the ${MAX_BYTES}-byte write limit`);
  }
  const abs = resolveSandboxedPath(ctx, filePath);
  // Snapshot the previous content (if any) BEFORE the write so the undo
  // executor can roll the file back. We cap the snapshot at MAX_BYTES so
  // a runaway file cannot blow the row size budget.
  let existed = false;
  let previousContent: string | null = null;
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile() && stat.size <= MAX_BYTES) {
      existed = true;
      previousContent = await fs.readFile(abs, "utf8");
    } else if (stat.isFile()) {
      existed = true;
    }
  } catch {
    existed = false;
  }
  await recordAction(ctx, {
    actionType: "file.write",
    description: existed
      ? `Overwrote ${filePath}`
      : `Created ${filePath}`,
    target: filePath,
    taskId: opts.taskId ?? null,
    beforeState: { path: filePath, existed, content: previousContent },
  });
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  await logPrivacyEvent(ctx, {
    eventType: "file.write",
    actor: ctx.userId ?? ctx.tenantId,
    target: filePath,
    severity: "low",
  });
  return { path: filePath, size: buf.byteLength };
}

export async function deleteFile(
  ctx: TenantContext,
  filePath: string,
  opts: { taskId?: string | null } = {},
): Promise<FileDeleteResult> {
  const abs = resolveSandboxedPath(ctx, filePath);
  // Snapshot the file BEFORE we unlink so the undo executor can write it
  // back. If the file is missing, there is nothing to undo and we skip
  // the recorder entirely.
  let snapshot: string | null = null;
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile() && stat.size <= MAX_BYTES) {
      snapshot = await fs.readFile(abs, "utf8");
    }
  } catch {
    return { path: filePath, deleted: false };
  }
  await recordAction(ctx, {
    actionType: "file.delete",
    description: `Deleted ${filePath}`,
    target: filePath,
    taskId: opts.taskId ?? null,
    beforeState: { path: filePath, existed: true, content: snapshot },
  });
  try {
    await fs.unlink(abs);
  } catch {
    return { path: filePath, deleted: false };
  }
  await logPrivacyEvent(ctx, {
    eventType: "file.delete",
    actor: ctx.userId ?? ctx.tenantId,
    target: filePath,
    severity: "medium",
  });
  return { path: filePath, deleted: true };
}

export interface FileMoveResult {
  fromPath: string;
  toPath: string;
}

/**
 * Move (rename) a file inside the sandbox. Records an undo entry so the
 * action can be reversed via the undo stack.
 */
export async function moveFile(
  ctx: TenantContext,
  fromPath: string,
  toPath: string,
  opts: { taskId?: string | null; rename?: boolean } = {},
): Promise<FileMoveResult> {
  const fromAbs = resolveSandboxedPath(ctx, fromPath);
  const toAbs = resolveSandboxedPath(ctx, toPath);
  await recordAction(ctx, {
    actionType: opts.rename ? "file.rename" : "file.move",
    description: opts.rename
      ? `Renamed ${fromPath} → ${toPath}`
      : `Moved ${fromPath} → ${toPath}`,
    target: toPath,
    taskId: opts.taskId ?? null,
    beforeState: { fromPath, toPath },
  });
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  await logPrivacyEvent(ctx, {
    eventType: opts.rename ? "file.rename" : "file.move",
    actor: ctx.userId ?? ctx.tenantId,
    target: toPath,
    severity: "low",
  });
  return { fromPath, toPath };
}
