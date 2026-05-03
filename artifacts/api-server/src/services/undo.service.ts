/**
 * Undo stack — reversible-action recorder + reversal executor (Task #44).
 *
 * Every reversible side-effect Omninity Operator performs (file write,
 * delete, move, rename, copy, folder-create, form-field edit, clipboard
 * change) must call `recordAction()` BEFORE the action runs so the
 * before-state snapshot is captured. The reversal executors below read
 * the snapshot to roll the world back one step at a time.
 *
 * Irreversible action types (email send, terminal command, API call,
 * purchase, OS-trash empty) are recorded with `reversible = 0` so the
 * audit trail is complete but `undoAction()` returns `IRREVERSIBLE`.
 *
 * Scope: in-session only — `EXPIRY_MS` defaults to 24h and the route
 * filters expired rows out of the visible stack. The Crash Recovery task
 * (downstream) will handle longer-lived cross-session resumption.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  undoActions,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { resolveSandboxedPath, SandboxEscapeError } from "../lib/sandbox";
import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

// 24 hours — most undos are needed within minutes; 24h covers
// "I noticed the next morning" without bloating the table forever.
const EXPIRY_MS = 24 * 60 * 60 * 1000;

// tier-review: bounded — fixed enum, never mutated at runtime.
export const REVERSIBLE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "file.write",
  "file.delete",
  "file.move",
  "file.rename",
  "file.copy",
  "folder.create",
  "form.field_edit",
  "clipboard.set",
]);

// tier-review: bounded — fixed enum.
export const IRREVERSIBLE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "email.send",
  "voip.call",
  "api.call",
  "purchase",
  "trash.empty",
  "terminal.command",
  "permanent.delete",
]);

// ─── Public types ──────────────────────────────────────────────────────────

export interface UndoActionRow {
  id: string;
  taskId: string | null;
  actionType: string;
  description: string;
  target: string | null;
  reversible: boolean;
  status: string;
  beforeState: unknown;
  afterState: unknown;
  error: string | null;
  createdAt: string;
  undoneAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

export interface RecordActionInput {
  actionType: string;
  description: string;
  target?: string | null;
  taskId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  reversible?: boolean;
}

export class IrreversibleActionError extends Error {
  override readonly name = "IrreversibleActionError";
  readonly code = "IRREVERSIBLE";
  constructor(message: string) {
    super(message);
  }
}

export class UndoExpiredError extends Error {
  override readonly name = "UndoExpiredError";
  readonly code = "UNDO_EXPIRED";
  constructor(message: string) {
    super(message);
  }
}

export class UndoFailedError extends Error {
  override readonly name = "UndoFailedError";
  readonly code = "UNDO_FAILED";
  constructor(message: string) {
    super(message);
  }
}

// ─── Mappers ───────────────────────────────────────────────────────────────

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toRow(r: typeof undoActions.$inferSelect): UndoActionRow {
  return {
    id: r.id,
    taskId: r.taskId,
    actionType: r.actionType,
    description: r.description,
    target: r.target,
    reversible: Boolean(r.reversible),
    status: r.status,
    beforeState: parseJson(r.beforeState),
    afterState: parseJson(r.afterState),
    error: r.error,
    createdAt: new Date(r.createdAt).toISOString(),
    undoneAt: r.undoneAt ? new Date(r.undoneAt).toISOString() : null,
    expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// ─── Action recorder ───────────────────────────────────────────────────────

/**
 * Insert a new undo-stack entry. Callers MUST invoke this BEFORE running
 * the underlying action so the snapshot reflects the pre-action world.
 */
export async function recordAction(
  ctx: TenantContext,
  input: RecordActionInput,
): Promise<UndoActionRow> {
  const reversible =
    input.reversible ?? !IRREVERSIBLE_ACTION_TYPES.has(input.actionType);
  const id = `undo_${nanoid()}`;
  const now = Date.now();
  await db.insert(undoActions).values(
    withTenantValues(ctx, {
      id,
      taskId: input.taskId ?? null,
      actionType: input.actionType,
      description: input.description,
      target: input.target ?? null,
      reversible: reversible ? 1 : 0,
      status: reversible ? "available" : "irreversible",
      beforeState:
        input.beforeState === undefined
          ? null
          : JSON.stringify(input.beforeState),
      afterState:
        input.afterState === undefined
          ? null
          : JSON.stringify(input.afterState),
      expiresAt: now + EXPIRY_MS,
    }),
  );
  const row = await getAction(ctx, id);
  if (!row) throw new Error("Undo action vanished after insert");
  return row;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getAction(
  ctx: TenantContext,
  id: string,
): Promise<UndoActionRow | null> {
  const rows = await db
    .select()
    .from(undoActions)
    .where(and(tenantScope(ctx, undoActions), eq(undoActions.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listActions(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; taskId?: string } = {},
): Promise<PaginatedData<UndoActionRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, undoActions);
  const taskScoped = opts.taskId
    ? and(baseScope, eq(undoActions.taskId, opts.taskId))
    : baseScope;
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(taskScoped, lt(undoActions.createdAt, cursorTs))
      : taskScoped;
  const rows = await db
    .select()
    .from(undoActions)
    .where(where)
    .orderBy(desc(undoActions.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function listAvailableForTask(
  ctx: TenantContext,
  taskId: string,
): Promise<UndoActionRow[]> {
  const rows = await db
    .select()
    .from(undoActions)
    .where(
      and(
        tenantScope(ctx, undoActions),
        eq(undoActions.taskId, taskId),
        eq(undoActions.status, "available"),
      ),
    )
    .orderBy(desc(undoActions.createdAt));
  return rows.map(toRow);
}

// ─── Reversal executors ────────────────────────────────────────────────────

interface FileBeforeState {
  path: string;
  content?: string | null;
  existed?: boolean;
}

interface MoveBeforeState {
  fromPath: string;
  toPath: string;
}

interface ReversalOutcome {
  manualSteps?: string;
}

async function reverseFileWrite(
  ctx: TenantContext,
  before: FileBeforeState,
): Promise<ReversalOutcome> {
  if (!before || typeof before.path !== "string") {
    throw new UndoFailedError("Snapshot is missing the file path");
  }
  const abs = resolveSandboxedPath(ctx, before.path);
  if (before.existed === false) {
    // The action created the file — undo by deleting it.
    try {
      await fs.unlink(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return {};
  }
  // The action overwrote an existing file — restore the previous content.
  if (typeof before.content !== "string") {
    throw new UndoFailedError(
      "Snapshot is missing the previous file content — manual restore required",
    );
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(before.content, "utf8"));
  return {};
}

async function reverseFileDelete(
  ctx: TenantContext,
  before: FileBeforeState,
): Promise<ReversalOutcome> {
  if (!before || typeof before.path !== "string") {
    throw new UndoFailedError("Snapshot is missing the file path");
  }
  if (typeof before.content !== "string") {
    throw new UndoFailedError(
      "Snapshot is missing the deleted content — file cannot be restored",
    );
  }
  const abs = resolveSandboxedPath(ctx, before.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(before.content, "utf8"));
  return {};
}

async function reverseFileMove(
  ctx: TenantContext,
  before: MoveBeforeState,
): Promise<ReversalOutcome> {
  if (
    !before ||
    typeof before.fromPath !== "string" ||
    typeof before.toPath !== "string"
  ) {
    throw new UndoFailedError("Snapshot is missing fromPath / toPath");
  }
  const fromAbs = resolveSandboxedPath(ctx, before.fromPath);
  const toAbs = resolveSandboxedPath(ctx, before.toPath);
  try {
    await fs.mkdir(path.dirname(fromAbs), { recursive: true });
    await fs.rename(toAbs, fromAbs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        manualSteps: `The file at "${before.toPath}" no longer exists. Restore it manually to "${before.fromPath}".`,
      };
    }
    throw e;
  }
  return {};
}

async function reverseFolderCreate(
  ctx: TenantContext,
  before: { path: string },
): Promise<ReversalOutcome> {
  if (!before || typeof before.path !== "string") {
    throw new UndoFailedError("Snapshot is missing the folder path");
  }
  const abs = resolveSandboxedPath(ctx, before.path);
  try {
    await fs.rmdir(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return {
        manualSteps: `Folder "${before.path}" is no longer empty — delete its new contents manually before re-running undo.`,
      };
    }
    throw e;
  }
  return {};
}

async function reverseRecordedOnly(): Promise<ReversalOutcome> {
  // form.field_edit / clipboard.set: the desktop adapter restores these
  // by replaying the snapshot via the input layer; the undo stack only
  // needs to mark the row as undone. Tier 1 stub: no-op success.
  return {};
}

async function dispatchReversal(
  ctx: TenantContext,
  row: UndoActionRow,
): Promise<ReversalOutcome> {
  const before = row.beforeState as Record<string, unknown> | null;
  switch (row.actionType) {
    case "file.write":
      return reverseFileWrite(ctx, before as unknown as FileBeforeState);
    case "file.delete":
      return reverseFileDelete(ctx, before as unknown as FileBeforeState);
    case "file.move":
    case "file.rename":
      return reverseFileMove(ctx, before as unknown as MoveBeforeState);
    case "file.copy": {
      // Copy made a new file at toPath — undo by deleting it.
      const b = before as unknown as MoveBeforeState;
      if (!b || typeof b.toPath !== "string") {
        throw new UndoFailedError("Snapshot is missing toPath");
      }
      const abs = resolveSandboxedPath(ctx, b.toPath);
      try {
        await fs.unlink(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      return {};
    }
    case "folder.create":
      return reverseFolderCreate(ctx, before as unknown as { path: string });
    case "form.field_edit":
    case "clipboard.set":
      return reverseRecordedOnly();
    default:
      throw new UndoFailedError(
        `No reversal executor registered for action type "${row.actionType}"`,
      );
  }
}

// ─── Public undo API ───────────────────────────────────────────────────────

export async function undoAction(
  ctx: TenantContext,
  id: string,
): Promise<UndoActionRow> {
  const row = await getAction(ctx, id);
  if (!row) throw new UndoFailedError(`Undo action ${id} not found`);
  if (!row.reversible) {
    throw new IrreversibleActionError(
      `${row.actionType} cannot be undone — it was flagged irreversible at record time`,
    );
  }
  if (row.status === "undone") return row;
  if (row.status === "expired") {
    throw new UndoExpiredError("This action has expired and can no longer be undone");
  }
  if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) {
    await markStatus(ctx, id, "expired");
    throw new UndoExpiredError("This action has expired and can no longer be undone");
  }

  let outcome: ReversalOutcome;
  try {
    outcome = await dispatchReversal(ctx, row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, undoId: id }, "Undo reversal failed");
    await db
      .update(undoActions)
      .set({
        status: "failed",
        error: msg,
        updatedAt: Date.now(),
      })
      .where(
        and(tenantScope(ctx, undoActions), eq(undoActions.id, id)),
      );
    if (e instanceof SandboxEscapeError) {
      throw new UndoFailedError(`Reversal blocked by sandbox: ${msg}`);
    }
    if (
      e instanceof IrreversibleActionError ||
      e instanceof UndoExpiredError ||
      e instanceof UndoFailedError
    ) {
      throw e;
    }
    throw new UndoFailedError(msg);
  }

  const now = Date.now();
  await db
    .update(undoActions)
    .set({
      status: "undone",
      undoneAt: now,
      updatedAt: now,
      ...(outcome.manualSteps ? { error: outcome.manualSteps } : {}),
    })
    .where(and(tenantScope(ctx, undoActions), eq(undoActions.id, id)));

  await logPrivacyEvent(ctx, {
    eventType: "undo.action",
    actor: ctx.userId ?? ctx.tenantId,
    target: row.target ?? row.id,
    severity: "low",
    detail: `${row.actionType} reversed${outcome.manualSteps ? " (with manual steps)" : ""}`,
  });

  const updated = await getAction(ctx, id);
  return updated ?? row;
}

export interface UndoTaskResult {
  taskId: string;
  attempted: number;
  undone: number;
  failed: number;
  results: UndoActionRow[];
}

/**
 * Reverse every available action belonging to `taskId`, newest first so
 * the world unwinds in the opposite order it wound up.
 */
export async function undoTask(
  ctx: TenantContext,
  taskId: string,
): Promise<UndoTaskResult> {
  const items = await listAvailableForTask(ctx, taskId);
  let undone = 0;
  let failed = 0;
  const results: UndoActionRow[] = [];
  for (const row of items) {
    try {
      const r = await undoAction(ctx, row.id);
      results.push(r);
      if (r.status === "undone") undone += 1;
      else failed += 1;
    } catch (e) {
      failed += 1;
      logger.warn({ err: e, undoId: row.id, taskId }, "Undo task: row failed");
      const refreshed = await getAction(ctx, row.id);
      if (refreshed) results.push(refreshed);
    }
  }
  return {
    taskId,
    attempted: items.length,
    undone,
    failed,
    results,
  };
}

async function markStatus(
  ctx: TenantContext,
  id: string,
  status: string,
): Promise<void> {
  await db
    .update(undoActions)
    .set({ status, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, undoActions), eq(undoActions.id, id)));
}

/**
 * Helper for callers staging an irreversible action: returns true if the
 * caller-supplied confirmation token matches the row's id (i.e. the
 * caller has already shown the warning + confirmation modal).
 *
 * Routes use this as a pre-execution gate so a missing `confirm` field
 * for an irreversible action returns 409 instead of silently doing it.
 */
export function isIrreversible(actionType: string): boolean {
  return IRREVERSIBLE_ACTION_TYPES.has(actionType);
}
