/**
 * Memories service — long-lived user memories surfaced by the Memory agent.
 *
 * Task #49 expanded the API surface from CRUD to a full long-term memory
 * pipeline:
 *
 *   - listMemories / getMemory / createMemory / deleteMemory : original
 *     CRUD, kept for backwards compatibility.
 *   - updateMemory                                          : edit fields
 *     in place (Memory panel "edit" action).
 *   - searchMemories                                        : keyword search
 *     scoped to the active tenant + workspace, used by the Memory panel.
 *   - retrieveRelevantMemories                              : pre-prompt
 *     retrieval — picks top-k entries ranked by overlap × confidence ×
 *     importance × recency. Bumps `lastAccessedAt` / `accessCount` on hit.
 *   - extractMemories                                       : post-message
 *     extraction. A deterministic local heuristic (no remote LLM) scans
 *     the conversation turn for factual / preference / pattern phrases,
 *     deduplicates against existing entries, and inserts new ones.
 *   - exportMemories                                        : JSON / Markdown
 *     dump for the privacy dashboard.
 *   - forgetAllMemories                                     : nuclear option
 *     — wipes every entry in the workspace and stamps `forgotten_at` on the
 *     settings row so the audit trail records the action.
 *   - getMemorySettings / updateMemorySettings              : capacity cap
 *     and auto-extract toggle.
 *   - getMemoryStats                                        : counts +
 *     bytes used / capacity, surfaced by the Memory panel header.
 *   - pruneMemories                                         : enforces the
 *     capacity cap by evicting unpinned entries ordered by (confidence asc,
 *     lastAccessedAt asc, importance asc, createdAt asc).
 *
 * Reads are tenant + workspace scoped. Writes use `withTenantValues` so the
 * tenant / workspace ids cannot be spoofed by the caller's payload.
 */
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  memories,
  memorySettings,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

// ─── Constants ───────────────────────────────────────────────────────────────

export const MEMORY_CATEGORIES = [
  "fact",
  "preference",
  "pattern",
  "contact",
  "project",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CONFIDENCES = ["confirmed", "observed", "inferred"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

const CONFIDENCE_WEIGHT: Record<MemoryConfidence, number> = {
  confirmed: 1,
  observed: 0.7,
  inferred: 0.4,
};

const DEFAULT_CAPACITY_BYTES = 50 * 1024 * 1024;

// ─── Row shape ───────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  kind: string;
  category: MemoryCategory;
  confidence: MemoryConfidence;
  title: string;
  content: string;
  importance: number;
  source: string | null;
  sourceConversationId: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  kind?: string;
  category?: MemoryCategory;
  confidence?: MemoryConfidence;
  title: string;
  content: string;
  importance?: number;
  source?: string;
  sourceConversationId?: string | null;
  pinned?: boolean;
}

export interface UpdateMemoryInput {
  category?: MemoryCategory;
  confidence?: MemoryConfidence;
  title?: string;
  content?: string;
  importance?: number;
  source?: string | null;
  pinned?: boolean;
}

export interface MemorySettingsRow {
  capacityBytes: number;
  autoExtract: boolean;
  lastPrunedAt: string | null;
  forgottenAt: string | null;
  updatedAt: string;
}

export interface MemoryStats {
  totalCount: number;
  totalBytes: number;
  capacityBytes: number;
  byCategory: Record<MemoryCategory, number>;
  byConfidence: Record<MemoryConfidence, number>;
  lastPrunedAt: string | null;
}

function normaliseCategory(v: string | null | undefined): MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(v ?? "")
    ? (v as MemoryCategory)
    : "fact";
}

function normaliseConfidence(v: string | null | undefined): MemoryConfidence {
  return (MEMORY_CONFIDENCES as readonly string[]).includes(v ?? "")
    ? (v as MemoryConfidence)
    : "confirmed";
}

function toRow(r: typeof memories.$inferSelect): MemoryRow {
  return {
    id: r.id,
    kind: r.kind,
    category: normaliseCategory(r.category),
    confidence: normaliseConfidence(r.confidence),
    title: r.title,
    content: r.content,
    importance: r.importance,
    source: r.source,
    sourceConversationId: r.sourceConversationId,
    lastAccessedAt: r.lastAccessedAt
      ? new Date(r.lastAccessedAt).toISOString()
      : null,
    accessCount: r.accessCount,
    pinned: r.pinned === 1,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// ─── Listing & singleton reads ───────────────────────────────────────────────

export async function listMemories(
  ctx: TenantContext,
  opts: {
    cursor?: string;
    limit?: number;
    category?: MemoryCategory;
    confidence?: MemoryConfidence;
    q?: string;
  } = {},
): Promise<PaginatedData<MemoryRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorParts = opts.cursor ? decodeCursor(opts.cursor).split(":") : null;
  const baseScope = tenantScope(ctx, memories);
  const filters: Array<ReturnType<typeof eq>> = [];
  if (opts.category) filters.push(eq(memories.category, opts.category));
  if (opts.confidence) filters.push(eq(memories.confidence, opts.confidence));
  let where = filters.length > 0 ? and(baseScope, ...filters) : baseScope;
  if (opts.q && opts.q.trim().length > 0) {
    const needle = `%${opts.q.trim().toLowerCase()}%`;
    const cond = or(
      sql`lower(${memories.title}) LIKE ${needle}`,
      sql`lower(${memories.content}) LIKE ${needle}`,
    );
    if (cond) where = and(where, cond) as typeof where;
  }
  if (cursorParts && cursorParts.length === 2) {
    const cImp = Number(cursorParts[0]);
    const cTs = Number(cursorParts[1]);
    if (Number.isFinite(cImp) && Number.isFinite(cTs)) {
      const cond = or(
        lt(memories.importance, cImp),
        and(eq(memories.importance, cImp), lt(memories.createdAt, cTs)),
      );
      if (cond) where = and(where, cond) as typeof where;
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

// ─── Mutations ───────────────────────────────────────────────────────────────

export async function createMemory(
  ctx: TenantContext,
  input: CreateMemoryInput,
): Promise<MemoryRow> {
  const id = `mem_${nanoid()}`;
  const importance = Math.max(0, Math.min(100, input.importance ?? 50));
  const category = normaliseCategory(input.category);
  const confidence = normaliseConfidence(input.confidence);
  await db.insert(memories).values(
    withTenantValues(ctx, {
      id,
      kind: input.kind ?? category,
      category,
      confidence,
      title: input.title,
      content: input.content,
      importance,
      source: input.source ?? null,
      sourceConversationId: input.sourceConversationId ?? null,
      pinned: input.pinned ? 1 : 0,
    }),
  );
  await pruneMemoriesIfOverCapacity(ctx);
  const row = await getMemory(ctx, id);
  if (!row) throw new Error("Memory not found after insert");
  return row;
}

export async function updateMemory(
  ctx: TenantContext,
  id: string,
  input: UpdateMemoryInput,
): Promise<MemoryRow | null> {
  const existing = await getMemory(ctx, id);
  if (!existing) return null;
  const patch: Partial<typeof memories.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (input.title !== undefined) patch.title = input.title;
  if (input.content !== undefined) patch.content = input.content;
  if (input.category !== undefined) patch.category = normaliseCategory(input.category);
  if (input.confidence !== undefined)
    patch.confidence = normaliseConfidence(input.confidence);
  if (input.importance !== undefined)
    patch.importance = Math.max(0, Math.min(100, input.importance));
  if (input.source !== undefined) patch.source = input.source;
  if (input.pinned !== undefined) patch.pinned = input.pinned ? 1 : 0;
  await db
    .update(memories)
    .set(patch)
    .where(and(tenantScope(ctx, memories), eq(memories.id, id)));
  return getMemory(ctx, id);
}

export async function deleteMemory(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getMemory(ctx, id);
  if (!existing) return { id, deleted: false };
  await db
    .delete(memories)
    .where(and(tenantScope(ctx, memories), eq(memories.id, id)));
  return { id, deleted: true };
}

// ─── Retrieval (pre-prompt context injection) ────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "my",
  "your",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "with",
  "from",
  "by",
  "as",
  "at",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "what",
  "when",
  "where",
  "who",
  "why",
  "how",
]);

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function scoreMemory(
  needle: Set<string>,
  row: typeof memories.$inferSelect,
): number {
  if (needle.size === 0) return 0;
  const hay = new Set(tokenise(`${row.title}\n${row.content}`));
  if (hay.size === 0) return 0;
  let overlap = 0;
  for (const w of needle) if (hay.has(w)) overlap++;
  if (overlap === 0) return 0;
  const overlapScore = overlap / Math.max(needle.size, 1);
  const confidence = CONFIDENCE_WEIGHT[normaliseConfidence(row.confidence)];
  const importance = Math.max(1, row.importance) / 100;
  const ageMs = Date.now() - row.createdAt;
  // Recency decays over a 30-day window down to 0.5x.
  const recency =
    1 - Math.min(0.5, ageMs / (30 * 24 * 60 * 60 * 1000) / 2);
  const pinBonus = row.pinned === 1 ? 1.25 : 1;
  return overlapScore * confidence * importance * recency * pinBonus;
}

export interface RetrievedMemory extends MemoryRow {
  score: number;
}

/**
 * Pre-prompt retrieval. Picks the top-`limit` memories most relevant to the
 * caller's query and bumps `lastAccessedAt` / `accessCount` on each hit so
 * the LRU pruner gives them priority.
 */
export async function retrieveRelevantMemories(
  ctx: TenantContext,
  query: string,
  opts: { limit?: number } = {},
): Promise<RetrievedMemory[]> {
  const k = Math.max(1, Math.min(20, opts.limit ?? 5));
  const needle = new Set(tokenise(query));
  if (needle.size === 0) return [];
  // Cheap filter: shortlist rows whose title OR content contains at least one
  // needle token before scoring locally. Avoids loading the full table.
  const likeClauses = Array.from(needle).map(
    (w) => sql`(lower(${memories.title}) LIKE ${"%" + w + "%"} OR lower(${
      memories.content
    }) LIKE ${"%" + w + "%"})`,
  );
  const orClause = likeClauses.reduce<ReturnType<typeof sql> | null>(
    (acc, clause) => (acc ? sql`${acc} OR ${clause}` : clause),
    null,
  );
  const where = orClause
    ? and(tenantScope(ctx, memories), orClause)
    : tenantScope(ctx, memories);
  const rows = await db.select().from(memories).where(where).limit(200);
  const scored = rows
    .map((r) => ({ row: r, score: scoreMemory(needle, r) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  if (scored.length > 0) {
    const now = Date.now();
    const ids = scored.map((s) => s.row.id);
    await db
      .update(memories)
      .set({ lastAccessedAt: now, accessCount: sql`${memories.accessCount} + 1` })
      .where(
        and(
          tenantScope(ctx, memories),
          sql`${memories.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
        ),
      );
  }

  return scored.map((s) => ({ ...toRow(s.row), score: Number(s.score.toFixed(4)) }));
}

// ─── Extraction (post-message learning) ──────────────────────────────────────

interface Candidate {
  category: MemoryCategory;
  confidence: MemoryConfidence;
  title: string;
  content: string;
  importance: number;
}

/**
 * Deterministic local heuristic that scans a conversation turn for facts and
 * preferences worth promoting into long-term memory. We keep this dependency
 * free (no remote LLM) so it runs entirely on-device — the task explicitly
 * requires that no memory ever leaves the machine.
 *
 * Patterns recognised:
 *   - "my <noun> is <value>"          → fact (confirmed)
 *   - "i (am|work|live|use) <value>"  → fact (confirmed)
 *   - "i prefer/like/want <value>"    → preference (confirmed)
 *   - "i (always|usually|often) <…>"  → pattern (observed)
 *   - "remember that <…>" / "note: <…>" → fact (confirmed)
 */
export function extractMemoryCandidates(
  text: string,
  opts: { maxCandidates?: number } = {},
): Candidate[] {
  const max = Math.max(1, Math.min(20, opts.maxCandidates ?? 8));
  const out: Candidate[] = [];
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 400);

  const push = (c: Candidate) => {
    if (out.length >= max) return;
    if (c.content.length < 3) return;
    out.push(c);
  };

  for (const raw of sentences) {
    const s = raw.replace(/\s+/g, " ").trim();
    const lower = s.toLowerCase();

    let m: RegExpExecArray | null;

    m = /^(?:remember(?: that)?|note(?: that)?|fyi[:,]?)\s*[:\-]?\s*(.+)$/i.exec(s);
    if (m && m[1]) {
      push({
        category: "fact",
        confidence: "confirmed",
        title: m[1].slice(0, 80),
        content: m[1],
        importance: 75,
      });
      continue;
    }

    m = /\bmy\s+([a-z][a-z\s]{1,40})\s+(?:is|are|=)\s+(.{2,200})$/i.exec(s);
    if (m && m[1] && m[2]) {
      const subject = m[1].trim();
      const value = m[2].replace(/[.!?]+$/, "").trim();
      push({
        category: subject.includes("colleague") || subject.includes("manager") ||
          subject.includes("client") || subject.includes("teammate")
          ? "contact"
          : "fact",
        confidence: "confirmed",
        title: `My ${subject}`,
        content: `My ${subject} is ${value}`,
        importance: 70,
      });
      continue;
    }

    m = /\bi\s+(prefer|like|love|want|need|hate|dislike)\s+(.{2,200})$/i.exec(s);
    if (m && m[1] && m[2]) {
      const verb = m[1].toLowerCase();
      const value = m[2].replace(/[.!?]+$/, "").trim();
      push({
        category: "preference",
        confidence: "confirmed",
        title: `Prefers ${value.slice(0, 60)}`,
        content: `User ${verb}s ${value}`,
        importance: 65,
      });
      continue;
    }

    m = /\bi\s+(always|usually|often|typically|tend to)\s+(.{2,200})$/i.exec(s);
    if (m && m[1] && m[2]) {
      const adv = m[1].toLowerCase();
      const value = m[2].replace(/[.!?]+$/, "").trim();
      push({
        category: "pattern",
        confidence: "observed",
        title: `${adv.charAt(0).toUpperCase() + adv.slice(1)} ${value.slice(0, 60)}`,
        content: `User ${adv} ${value}`,
        importance: 55,
      });
      continue;
    }

    m = /\bi\s+(am|work\s+at|work\s+for|live\s+in|use)\s+(.{2,200})$/i.exec(s);
    if (m && m[1] && m[2]) {
      const verb = m[1].toLowerCase();
      const value = m[2].replace(/[.!?]+$/, "").trim();
      push({
        category: verb.startsWith("work") ? "project" : "fact",
        confidence: "confirmed",
        title: `${verb} ${value.slice(0, 60)}`,
        content: `User ${verb} ${value}`,
        importance: 60,
      });
      continue;
    }

    if (
      lower.startsWith("we always") ||
      lower.startsWith("we usually") ||
      lower.startsWith("we typically")
    ) {
      push({
        category: "pattern",
        confidence: "observed",
        title: s.slice(0, 80),
        content: s,
        importance: 55,
      });
    }
  }

  return out;
}

function dedupeKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .sort()
    .join(" ");
}

/**
 * Run the extractor against a message and persist novel candidates as memory
 * entries linked to the originating conversation.
 */
export async function extractMemories(
  ctx: TenantContext,
  input: { text: string; conversationId?: string | null },
): Promise<{ created: MemoryRow[]; skipped: number }> {
  const settings = await getMemorySettings(ctx);
  if (!settings.autoExtract) return { created: [], skipped: 0 };
  const candidates = extractMemoryCandidates(input.text);
  if (candidates.length === 0) return { created: [], skipped: 0 };

  // Deduplicate against existing memories using a normalised bag-of-words
  // signature. Cheap and fully deterministic.
  const existingRows = await db
    .select()
    .from(memories)
    .where(tenantScope(ctx, memories))
    .limit(500);
  const seen = new Set(existingRows.map((r) => dedupeKey(r.content)));

  const created: MemoryRow[] = [];
  let skipped = 0;
  for (const c of candidates) {
    const key = dedupeKey(c.content);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const row = await createMemory(ctx, {
      kind: c.category,
      category: c.category,
      confidence: c.confidence,
      title: c.title,
      content: c.content,
      importance: c.importance,
      sourceConversationId: input.conversationId ?? null,
      source: "extractor",
    });
    created.push(row);
  }
  return { created, skipped };
}

// ─── Settings ────────────────────────────────────────────────────────────────

function settingsRow(r: typeof memorySettings.$inferSelect): MemorySettingsRow {
  return {
    capacityBytes: r.capacityBytes,
    autoExtract: r.autoExtract === 1,
    lastPrunedAt: r.lastPrunedAt ? new Date(r.lastPrunedAt).toISOString() : null,
    forgottenAt: r.forgottenAt ? new Date(r.forgottenAt).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function getMemorySettings(
  ctx: TenantContext,
): Promise<MemorySettingsRow> {
  const rows = await db
    .select()
    .from(memorySettings)
    .where(tenantScope(ctx, memorySettings))
    .limit(1);
  if (rows[0]) return settingsRow(rows[0]);
  const id = `mset_${nanoid()}`;
  await db.insert(memorySettings).values(
    withTenantValues(ctx, {
      id,
      capacityBytes: DEFAULT_CAPACITY_BYTES,
      autoExtract: 1,
    }),
  );
  const created = await db
    .select()
    .from(memorySettings)
    .where(tenantScope(ctx, memorySettings))
    .limit(1);
  if (!created[0]) throw new Error("Failed to seed memory settings");
  return settingsRow(created[0]);
}

export async function updateMemorySettings(
  ctx: TenantContext,
  patch: { capacityBytes?: number; autoExtract?: boolean },
): Promise<MemorySettingsRow> {
  await getMemorySettings(ctx);
  const update: Partial<typeof memorySettings.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (patch.capacityBytes !== undefined) {
    update.capacityBytes = Math.max(
      1024 * 1024,
      Math.min(1024 * 1024 * 1024, Math.round(patch.capacityBytes)),
    );
  }
  if (patch.autoExtract !== undefined) {
    update.autoExtract = patch.autoExtract ? 1 : 0;
  }
  await db
    .update(memorySettings)
    .set(update)
    .where(tenantScope(ctx, memorySettings));
  return getMemorySettings(ctx);
}

// ─── Stats / export / forget-all ─────────────────────────────────────────────

function computeBytes(rows: ReadonlyArray<typeof memories.$inferSelect>): number {
  let total = 0;
  for (const r of rows) {
    total += Buffer.byteLength(r.title, "utf8") + Buffer.byteLength(r.content, "utf8");
  }
  return total;
}

export async function getMemoryStats(ctx: TenantContext): Promise<MemoryStats> {
  const rows = await db
    .select()
    .from(memories)
    .where(tenantScope(ctx, memories));
  const settings = await getMemorySettings(ctx);
  const byCategory: Record<MemoryCategory, number> = {
    fact: 0,
    preference: 0,
    pattern: 0,
    contact: 0,
    project: 0,
  };
  const byConfidence: Record<MemoryConfidence, number> = {
    confirmed: 0,
    observed: 0,
    inferred: 0,
  };
  for (const r of rows) {
    byCategory[normaliseCategory(r.category)]++;
    byConfidence[normaliseConfidence(r.confidence)]++;
  }
  return {
    totalCount: rows.length,
    totalBytes: computeBytes(rows),
    capacityBytes: settings.capacityBytes,
    byCategory,
    byConfidence,
    lastPrunedAt: settings.lastPrunedAt,
  };
}

export type MemoryExportFormat = "json" | "markdown";

export async function exportMemories(
  ctx: TenantContext,
  format: MemoryExportFormat,
): Promise<{ format: MemoryExportFormat; mediaType: string; body: string; count: number }> {
  const rows = await db
    .select()
    .from(memories)
    .where(tenantScope(ctx, memories))
    .orderBy(desc(memories.createdAt));
  const items = rows.map(toRow);
  if (format === "markdown") {
    const lines: string[] = ["# Memories", ""];
    for (const m of items) {
      lines.push(`## ${m.title}`);
      lines.push("");
      lines.push(`- **Category:** ${m.category}`);
      lines.push(`- **Confidence:** ${m.confidence}`);
      lines.push(`- **Importance:** ${m.importance}`);
      lines.push(`- **Created:** ${m.createdAt}`);
      if (m.sourceConversationId) {
        lines.push(`- **Source conversation:** ${m.sourceConversationId}`);
      }
      lines.push("");
      lines.push(m.content);
      lines.push("");
    }
    return {
      format,
      mediaType: "text/markdown",
      body: lines.join("\n"),
      count: items.length,
    };
  }
  return {
    format,
    mediaType: "application/json",
    body: JSON.stringify({ items, exportedAt: new Date().toISOString() }, null, 2),
    count: items.length,
  };
}

export async function forgetAllMemories(
  ctx: TenantContext,
): Promise<{ deletedCount: number; forgottenAt: string }> {
  const rows = await db
    .select({ id: memories.id })
    .from(memories)
    .where(tenantScope(ctx, memories));
  await db.delete(memories).where(tenantScope(ctx, memories));
  await getMemorySettings(ctx);
  const now = Date.now();
  await db
    .update(memorySettings)
    .set({ forgottenAt: now, updatedAt: now })
    .where(tenantScope(ctx, memorySettings));
  return {
    deletedCount: rows.length,
    forgottenAt: new Date(now).toISOString(),
  };
}

// ─── Pruning (capacity enforcement) ──────────────────────────────────────────

export async function pruneMemoriesIfOverCapacity(
  ctx: TenantContext,
): Promise<{ pruned: number; bytesAfter: number }> {
  const settings = await getMemorySettings(ctx);
  const rows = await db
    .select()
    .from(memories)
    .where(and(tenantScope(ctx, memories), eq(memories.pinned, 0)))
    .orderBy(
      asc(
        sql`CASE ${memories.confidence} WHEN 'inferred' THEN 0 WHEN 'observed' THEN 1 ELSE 2 END`,
      ),
      asc(sql`COALESCE(${memories.lastAccessedAt}, ${memories.createdAt})`),
      asc(memories.importance),
      asc(memories.createdAt),
    );
  let totalBytes = computeBytes(rows);
  if (totalBytes <= settings.capacityBytes) {
    return { pruned: 0, bytesAfter: totalBytes };
  }
  let pruned = 0;
  const evictIds: string[] = [];
  for (const r of rows) {
    if (totalBytes <= settings.capacityBytes) break;
    const size =
      Buffer.byteLength(r.title, "utf8") + Buffer.byteLength(r.content, "utf8");
    evictIds.push(r.id);
    totalBytes -= size;
    pruned++;
  }
  if (evictIds.length > 0) {
    await db
      .delete(memories)
      .where(
        and(
          tenantScope(ctx, memories),
          sql`${memories.id} IN (${sql.join(evictIds.map((id) => sql`${id}`), sql`, `)})`,
        ),
      );
    const now = Date.now();
    await db
      .update(memorySettings)
      .set({ lastPrunedAt: now, updatedAt: now })
      .where(tenantScope(ctx, memorySettings));
  }
  return { pruned, bytesAfter: totalBytes };
}

export async function pruneMemories(
  ctx: TenantContext,
): Promise<{ pruned: number; bytesAfter: number }> {
  return pruneMemoriesIfOverCapacity(ctx);
}
