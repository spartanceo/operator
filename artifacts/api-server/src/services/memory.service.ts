/**
 * Memories service — long-lived user memories surfaced by the Memory agent.
 *
 * Reads are tenant-scoped and ordered by descending importance + recency.
 * Writes use `withTenantValues` so the row's `tenantId`/`workspaceId` cannot
 * be set by the caller's payload.
 */
import { and, desc, eq, lt, or } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  memories,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export interface MemoryRow {
  id: string;
  kind: string;
  title: string;
  content: string;
  importance: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  kind?: string;
  title: string;
  content: string;
  importance?: number;
  source?: string;
}

function toRow(r: typeof memories.$inferSelect): MemoryRow {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    importance: r.importance,
    source: r.source,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listMemories(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<MemoryRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorParts = opts.cursor ? decodeCursor(opts.cursor).split(":") : null;
  const baseScope = tenantScope(ctx, memories);
  let where = baseScope;
  if (cursorParts && cursorParts.length === 2) {
    const cImp = Number(cursorParts[0]);
    const cTs = Number(cursorParts[1]);
    if (Number.isFinite(cImp) && Number.isFinite(cTs)) {
      // Keyset pagination on (importance DESC, createdAt DESC):
      // next page = importance < cImp OR (importance == cImp AND createdAt < cTs).
      const cond = or(
        lt(memories.importance, cImp),
        and(eq(memories.importance, cImp), lt(memories.createdAt, cTs)),
      );
      if (cond) where = and(baseScope, cond) as typeof baseScope;
    }
  }
  const rows = await db
    .select()
    .from(memories)
    .where(where)
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) => {
    const ts = new Date(r.createdAt).getTime();
    return `${r.importance}:${ts}`;
  });
}

export async function getMemory(
  ctx: TenantContext,
  id: string,
): Promise<MemoryRow | null> {
  const rows = await db
    .select()
    .from(memories)
    .where(and(tenantScope(ctx, memories), eq(memories.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createMemory(
  ctx: TenantContext,
  input: CreateMemoryInput,
): Promise<MemoryRow> {
  const id = `mem_${nanoid()}`;
  const importance = Math.max(0, Math.min(100, input.importance ?? 50));
  await db.insert(memories).values(
    withTenantValues(ctx, {
      id,
      kind: input.kind ?? "fact",
      title: input.title,
      content: input.content,
      importance,
      source: input.source ?? null,
    }),
  );
  const row = await getMemory(ctx, id);
  if (!row) throw new Error("Memory not found after insert");
  return row;
}

export async function deleteMemory(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getMemory(ctx, id);
  if (!existing) return { id, deleted: false };
  await db.delete(memories).where(and(tenantScope(ctx, memories), eq(memories.id, id)));
  return { id, deleted: true };
}
