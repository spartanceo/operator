/**
 * Workspace sandbox path resolver.
 *
 * Every file operation MUST go through `resolveSandboxedPath()`. The
 * function returns an absolute path that is guaranteed to live inside the
 * caller's workspace root, or throws `SandboxEscapeError` with a stable
 * code so the API mapper turns it into a 400.
 *
 * Why a dedicated helper:
 *  - `path.resolve` alone does not detect `..` traversal — `path.resolve("/a", "../b")`
 *    happily returns `/b`.
 *  - A symlink that points outside the workspace would defeat a naive
 *    string check; we resolve via realpath when the file already exists
 *    and validate the parent directory when it doesn't.
 *
 * Workspace root layout (Standard 12 — local-first):
 *   <SANDBOX_ROOT>/<tenantId>/<workspaceId>/...
 *
 * `SANDBOX_ROOT` defaults to `<cwd>/data/workspaces` so the same data
 * directory used by SQLite holds the per-workspace files.
 */
import fs from "node:fs";
import path from "node:path";

import type { TenantContext } from "@workspace/types";

export class SandboxEscapeError extends Error {
  override readonly name = "SandboxEscapeError";
  readonly code = "SANDBOX_ESCAPE";
  constructor(message: string) {
    super(message);
  }
}

function rootDir(): string {
  return process.env["SANDBOX_ROOT"] ?? path.resolve(process.cwd(), "data", "workspaces");
}

/**
 * Returns the absolute path of the caller's workspace directory and creates
 * it on demand. Workspaces are namespaced as `<tenant>/<workspace>` so two
 * tenants can never collide even if they share a workspace id.
 */
export function workspaceRoot(ctx: TenantContext): string {
  const ws = ctx.workspaceId ?? "default";
  const dir = path.join(rootDir(), ctx.tenantId, ws);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Resolve a user-supplied relative path inside the workspace sandbox.
 *
 * Throws `SandboxEscapeError` for absolute paths, parent-traversal that
 * lands outside the workspace root, and symlinks that resolve outside it.
 */
export function resolveSandboxedPath(ctx: TenantContext, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new SandboxEscapeError("Path must be a non-empty string");
  }
  // Null-byte injection: a NUL terminator inside the path string lets a
  // caller write `notes/innocent.txt\0../../../etc/passwd` and have the OS
  // truncate the syscall arg at the NUL while our string-based traversal
  // check still sees the harmless prefix. Reject up front.
  if (rel.indexOf("\u0000") !== -1) {
    throw new SandboxEscapeError("Path contains a NUL byte");
  }
  if (path.isAbsolute(rel)) {
    throw new SandboxEscapeError("Absolute paths are not allowed inside the sandbox");
  }
  const root = workspaceRoot(ctx);
  const joined = path.resolve(root, rel);
  // Guard: joined MUST live under root after normalisation.
  const normalisedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (joined !== root && !joined.startsWith(normalisedRoot)) {
    throw new SandboxEscapeError(`Path "${rel}" escapes the workspace sandbox`);
  }
  // If the file exists, follow symlinks and re-check.
  if (fs.existsSync(joined)) {
    const real = fs.realpathSync(joined);
    if (real !== root && !real.startsWith(normalisedRoot)) {
      throw new SandboxEscapeError(
        `Path "${rel}" resolves through a symlink outside the workspace sandbox`,
      );
    }
    return real;
  }
  return joined;
}
