/**
 * Conversation service — multi-thread conversation management (Task #41).
 *
 * Conversations group `messages` and `agent_runs` into addressable threads.
 * The OperatorShell sidebar lets users create new threads, pin/archive,
 * delete, search, and resume any past conversation. Each conversation is
 * tenant-scoped and carries denormalised `lastMessageAt` /
 * `lastMessagePreview` / `messageCount` columns so the sidebar can render
 * without a JOIN per row.
 *
 * Reads are tenant-scoped via `tenantScope(...)`. Writes use
 * `withTenantValues(...)` so a malicious payload can never override the
 * tenant_id stamp. Deletes cascade through `messages`, `tool_calls`,
 * `approvals`, and `agent_runs` for the conversation — every dependent
 * row carries the same tenant_id, so the cleanup is a tenant-scoped DELETE
 * per table.
 */
import { and, asc, desc, eq, gt, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import PDFDocument from "pdfkit";

import {
  agentRuns,
  approvals,
  buildPage,
  conversations,
  db,
  decodeCursor,
  messages as messagesTable,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  toolCalls as toolCallsTable,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export interface ConversationRow {
  id: string;
  title: string;
  summary: string | null;
  pinned: boolean;
  archived: boolean;
  pinnedAt: string | null;
  archivedAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  messageCount: number;
  agentMode: boolean;
  modelName: string | null;
  desktopUsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  title?: string;
  agentMode?: boolean;
  modelName?: string;
}

export interface UpdateConversationInput {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  agentMode?: boolean;
  modelName?: string | null;
}

export interface ListConversationsOpts {
  cursor?: string;
  limit?: number;
  /** Filter: include archived rows (default false). */
  includeArchived?: boolean;
  /** When true, return *only* archived rows. */
  archivedOnly?: boolean;
  /** Free-text title prefix filter (case-insensitive contains). */
  q?: string;
  /**
   * Only conversations updated/last-active on or after this ISO date
   * (UTC). Powers the "since" filter on the sidebar.
   */
  since?: string;
  /** When true, only conversations that ever ran the agent. */
  agentOnly?: boolean;
  /** When true, only conversations whose desktopUsed flag is set. */
  desktopOnly?: boolean;
}

export interface ConversationSearchHit {
  conversationId: string;
  conversationTitle: string;
  matchType: "message" | "run" | "tool";
  matchId: string;
  preview: string;
  role: string | null;
  createdAt: string;
}

const PREVIEW_MAX = 200;

function toPreview(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= PREVIEW_MAX) return trimmed;
  return `${trimmed.slice(0, PREVIEW_MAX - 1)}…`;
}

function toRow(r: typeof conversations.$inferSelect): ConversationRow {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    pinned: Boolean(r.pinned),
    archived: Boolean(r.archived),
    pinnedAt: r.pinnedAt ? new Date(r.pinnedAt).toISOString() : null,
    archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null,
    lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
    lastMessagePreview: r.lastMessagePreview,
    messageCount: r.messageCount,
    agentMode: Boolean(r.agentMode),
    modelName: r.modelName,
    desktopUsed: Boolean(r.desktopUsed),
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export function deriveTitle(seed: string): string {
  const trimmed = seed.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "New conversation";
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}

export async function listConversations(
  ctx: TenantContext,
  opts: ListConversationsOpts = {},
): Promise<PaginatedData<ConversationRow>> {
  const limit = normaliseLimit(opts.limit);
  const baseScope = tenantScope(ctx, conversations);
  const conds = [baseScope];

  if (opts.archivedOnly) {
    conds.push(eq(conversations.archived, 1));
  } else if (!opts.includeArchived) {
    conds.push(eq(conversations.archived, 0));
  }

  if (opts.q && opts.q.trim().length > 0) {
    const like1 = `%${opts.q.trim()}%`;
    const titleLike = like(conversations.title, like1);
    if (titleLike) conds.push(titleLike);
  }

  if (opts.agentOnly) conds.push(eq(conversations.agentMode, 1));
  if (opts.desktopOnly) conds.push(eq(conversations.desktopUsed, 1));
  if (opts.since) {
    const ms = Date.parse(opts.since);
    if (Number.isFinite(ms)) {
      const sortExpr = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`;
      conds.push(gte(sortExpr, ms));
    }
  }

  // Cursor encodes "<pinned>:<sortTs>" so pinned rows always come first
  // and the cursor walks across both buckets in (pinned DESC, ts DESC).
  if (opts.cursor) {
    const parts = decodeCursor(opts.cursor).split(":");
    if (parts.length === 2) {
      const cPinned = Number(parts[0]);
      const cTs = Number(parts[1]);
      if (Number.isFinite(cPinned) && Number.isFinite(cTs)) {
        const sortExpr = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`;
        const cond = or(
          lt(conversations.pinned, cPinned),
          and(eq(conversations.pinned, cPinned), lt(sortExpr, cTs)),
        );
        if (cond) conds.push(cond);
      }
    }
  }

  const where = and(...conds);
  const sortExpr = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`;
  const rows = await db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(desc(conversations.pinned), desc(sortExpr))
    .limit(limit + 1);

  return buildPage(rows.map(toRow), limit, (r) => {
    const raw = rows.find((x) => x.id === r.id)!;
    const ts = raw.lastMessageAt ?? raw.createdAt;
    return `${raw.pinned}:${ts}`;
  });
}

export async function getConversation(
  ctx: TenantContext,
  id: string,
): Promise<ConversationRow | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(tenantScope(ctx, conversations), eq(conversations.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createConversation(
  ctx: TenantContext,
  input: CreateConversationInput = {},
): Promise<ConversationRow> {
  const id = `conv_${nanoid()}`;
  const title = deriveTitle(input.title ?? "New conversation");
  await db.insert(conversations).values(
    withTenantValues(ctx, {
      id,
      title,
      agentMode: input.agentMode ? 1 : 0,
      modelName: input.modelName ?? null,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
    }),
  );
  const row = await getConversation(ctx, id);
  if (!row) throw new Error("Conversation vanished after insert");
  return row;
}

export async function updateConversation(
  ctx: TenantContext,
  id: string,
  input: UpdateConversationInput,
): Promise<ConversationRow | null> {
  const existing = await getConversation(ctx, id);
  if (!existing) return null;
  const now = Date.now();
  const patch: Record<string, unknown> = { updatedAt: now };

  if (input.title !== undefined) patch["title"] = deriveTitle(input.title);
  if (input.pinned !== undefined) {
    patch["pinned"] = input.pinned ? 1 : 0;
    patch["pinnedAt"] = input.pinned ? now : null;
  }
  if (input.archived !== undefined) {
    patch["archived"] = input.archived ? 1 : 0;
    patch["archivedAt"] = input.archived ? now : null;
  }
  if (input.agentMode !== undefined) patch["agentMode"] = input.agentMode ? 1 : 0;
  if (input.modelName !== undefined) patch["modelName"] = input.modelName;

  await db
    .update(conversations)
    .set(patch)
    .where(and(tenantScope(ctx, conversations), eq(conversations.id, id)));
  return getConversation(ctx, id);
}

export interface DeleteConversationResult {
  deleted: boolean;
  removedMessages: number;
  removedRuns: number;
}

export async function deleteConversation(
  ctx: TenantContext,
  id: string,
): Promise<DeleteConversationResult> {
  const existing = await getConversation(ctx, id);
  if (!existing) {
    return { deleted: false, removedMessages: 0, removedRuns: 0 };
  }

  // Find runs first so we can cascade tool_calls + approvals before agent_runs.
  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(tenantScope(ctx, agentRuns), eq(agentRuns.conversationId, id)),
    );
  const runIds = runRows.map((r) => r.id);

  if (runIds.length > 0) {
    await db
      .delete(approvals)
      .where(
        and(tenantScope(ctx, approvals), inArray(approvals.runId, runIds)),
      );
    await db
      .delete(toolCallsTable)
      .where(
        and(
          tenantScope(ctx, toolCallsTable),
          inArray(toolCallsTable.runId, runIds),
        ),
      );
    // Some run-scoped messages (KB/memory/research/desktop notes) are
    // inserted without a conversationId — clean them up by run_id before
    // we delete the agent_runs row to avoid FK violations.
    await db
      .delete(messagesTable)
      .where(
        and(
          tenantScope(ctx, messagesTable),
          inArray(messagesTable.runId, runIds),
        ),
      );
  }

  const msgRes = await db
    .delete(messagesTable)
    .where(
      and(
        tenantScope(ctx, messagesTable),
        eq(messagesTable.conversationId, id),
      ),
    );

  await db
    .delete(agentRuns)
    .where(and(tenantScope(ctx, agentRuns), eq(agentRuns.conversationId, id)));

  await db
    .delete(conversations)
    .where(and(tenantScope(ctx, conversations), eq(conversations.id, id)));

  // better-sqlite3 returns { changes } via the run handle, but drizzle hides
  // it — return the run count we actually walked and a best-effort message
  // count from the dependent query envelope.
  const removedMessages =
    typeof (msgRes as { changes?: number }).changes === "number"
      ? (msgRes as { changes: number }).changes
      : 0;

  return { deleted: true, removedMessages, removedRuns: runIds.length };
}

/**
 * Append a chat message to a conversation and bump the denormalised
 * sidebar columns. Returns the inserted row id.
 */
export async function appendMessage(
  ctx: TenantContext,
  conversationId: string,
  input: { role: string; content: string; runId?: string | null },
): Promise<{ id: string }> {
  const existing = await getConversation(ctx, conversationId);
  if (!existing) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const id = `msg_${nanoid()}`;
  const now = Date.now();
  await db.insert(messagesTable).values(
    withTenantValues(ctx, {
      id,
      conversationId,
      runId: input.runId ?? null,
      role: input.role,
      content: input.content,
    }),
  );
  await db
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastMessagePreview: toPreview(input.content),
      messageCount: existing.messageCount + 1,
      updatedAt: now,
      // Auto-title: when the first user turn lands on a default-titled
      // conversation, replace the placeholder with a derived title.
      ...(existing.messageCount === 0 &&
      input.role === "user" &&
      (existing.title === "New conversation" || existing.title.length === 0)
        ? { title: deriveTitle(input.content) }
        : {}),
    })
    .where(
      and(tenantScope(ctx, conversations), eq(conversations.id, conversationId)),
    );
  return { id };
}

export async function listConversationMessages(
  ctx: TenantContext,
  conversationId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<
  PaginatedData<{
    id: string;
    role: string;
    content: string;
    runId: string | null;
    pinned: boolean;
    isSummary: boolean;
    createdAt: string;
  }>
> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = and(
    tenantScope(ctx, messagesTable),
    eq(messagesTable.conversationId, conversationId),
  );
  // Chronological (oldest → newest) so the chat transcript reads top-to-bottom
  // and so we can forward the array directly to an LLM as prompt history.
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, gt(messagesTable.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(messagesTable)
    .where(where)
    .orderBy(asc(messagesTable.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      runId: r.runId,
      pinned: Boolean(r.pinned),
      isSummary: Boolean(r.isSummary),
      createdAt: new Date(r.createdAt).toISOString(),
    })),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

/**
 * Full-text search across messages and agent-run goals scoped to the
 * tenant. Returns up to 50 hits, ordered by createdAt DESC. Matching is a
 * SQL LIKE — the indexes on `tenant_id` keep the scan bounded; we cap the
 * limit to 50 hits per query for predictable latency.
 */
export async function searchConversations(
  ctx: TenantContext,
  query: string,
  opts: { limit?: number } = {},
): Promise<ConversationSearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const cap = Math.min(Math.max(opts.limit ?? 25, 1), 50);
  const pattern = `%${trimmed}%`;

  const messageHits = await db
    .select({
      conversationId: messagesTable.conversationId,
      messageId: messagesTable.id,
      role: messagesTable.role,
      content: messagesTable.content,
      createdAt: messagesTable.createdAt,
    })
    .from(messagesTable)
    .where(
      and(
        tenantScope(ctx, messagesTable),
        like(messagesTable.content, pattern),
      ),
    )
    .orderBy(desc(messagesTable.createdAt))
    .limit(cap);

  const runHits = await db
    .select({
      conversationId: agentRuns.conversationId,
      runId: agentRuns.id,
      goal: agentRuns.goal,
      summary: agentRuns.summary,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        tenantScope(ctx, agentRuns),
        or(
          like(agentRuns.goal, pattern),
          like(agentRuns.summary, pattern),
          like(agentRuns.plan, pattern),
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(cap);

  // Tool-call corpus: search the tool name, the input payload (which contains
  // file names + flags), and the captured output. Hits are mapped back to
  // their parent run's conversation so the user can jump straight there.
  const toolHits = await db
    .select({
      runId: toolCallsTable.runId,
      callId: toolCallsTable.id,
      toolName: toolCallsTable.toolName,
      input: toolCallsTable.input,
      output: toolCallsTable.output,
      createdAt: toolCallsTable.createdAt,
    })
    .from(toolCallsTable)
    .where(
      and(
        tenantScope(ctx, toolCallsTable),
        or(
          like(toolCallsTable.toolName, pattern),
          like(toolCallsTable.input, pattern),
          like(toolCallsTable.output, pattern),
        ),
      ),
    )
    .orderBy(desc(toolCallsTable.createdAt))
    .limit(cap);

  // Resolve each tool hit's runId → conversationId so we can stitch into the
  // shared hit list below.
  const toolRunIds = Array.from(new Set(toolHits.map((h) => h.runId)));
  const toolRunRows = toolRunIds.length
    ? await db
        .select({ id: agentRuns.id, conversationId: agentRuns.conversationId })
        .from(agentRuns)
        .where(and(tenantScope(ctx, agentRuns), inArray(agentRuns.id, toolRunIds)))
    : [];
  const convByRun = new Map(toolRunRows.map((r) => [r.id, r.conversationId]));

  const convIds = Array.from(
    new Set(
      [
        ...messageHits.map((h) => h.conversationId),
        ...runHits.map((h) => h.conversationId),
        ...toolHits.map((h) => convByRun.get(h.runId) ?? null),
      ].filter((x): x is string => Boolean(x)),
    ),
  );

  const convRows = convIds.length
    ? await db
        .select({ id: conversations.id, title: conversations.title })
        .from(conversations)
        .where(
          and(
            tenantScope(ctx, conversations),
            inArray(conversations.id, convIds),
          ),
        )
    : [];
  const titleById = new Map(convRows.map((r) => [r.id, r.title]));

  const hits: ConversationSearchHit[] = [];
  for (const m of messageHits) {
    if (!m.conversationId) continue;
    const title = titleById.get(m.conversationId);
    if (!title) continue;
    hits.push({
      conversationId: m.conversationId,
      conversationTitle: title,
      matchType: "message",
      matchId: m.messageId,
      preview: toPreview(m.content),
      role: m.role,
      createdAt: new Date(m.createdAt).toISOString(),
    });
  }
  for (const r of runHits) {
    if (!r.conversationId) continue;
    const title = titleById.get(r.conversationId);
    if (!title) continue;
    hits.push({
      conversationId: r.conversationId,
      conversationTitle: title,
      matchType: "run",
      matchId: r.runId,
      preview: toPreview(r.summary ?? r.goal),
      role: null,
      createdAt: new Date(r.createdAt).toISOString(),
    });
  }
  for (const t of toolHits) {
    const cId = convByRun.get(t.runId);
    if (!cId) continue;
    const title = titleById.get(cId);
    if (!title) continue;
    hits.push({
      conversationId: cId,
      conversationTitle: title,
      matchType: "tool",
      matchId: t.callId,
      preview: toPreview(`${t.toolName}: ${t.output ?? t.input}`),
      role: t.toolName,
      createdAt: new Date(t.createdAt).toISOString(),
    });
  }
  hits.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return hits.slice(0, cap);
}

interface ExportPayload {
  format: "markdown" | "json" | "pdf";
  filename: string;
  contentType: string;
  /** Plain text body (markdown / json) or base64-encoded binary (PDF). */
  body: string;
  /** True when `body` is base64-encoded. */
  encoding?: "base64";
}

export async function exportConversation(
  ctx: TenantContext,
  id: string,
  format: "markdown" | "json" | "pdf",
): Promise<ExportPayload | null> {
  const conv = await getConversation(ctx, id);
  if (!conv) return null;

  const msgRows = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        tenantScope(ctx, messagesTable),
        eq(messagesTable.conversationId, id),
      ),
    )
    .orderBy(messagesTable.createdAt);

  const runRows = await db
    .select()
    .from(agentRuns)
    .where(and(tenantScope(ctx, agentRuns), eq(agentRuns.conversationId, id)))
    .orderBy(agentRuns.createdAt);

  const safeTitle = conv.title.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 80) || "conversation";

  if (format === "json") {
    const body = JSON.stringify(
      {
        conversation: conv,
        messages: msgRows.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          runId: m.runId,
          createdAt: new Date(m.createdAt).toISOString(),
        })),
        runs: runRows.map((r) => ({
          id: r.id,
          goal: r.goal,
          status: r.status,
          summary: r.summary,
          plan: r.plan,
          createdAt: new Date(r.createdAt).toISOString(),
        })),
      },
      null,
      2,
    );
    return {
      format,
      filename: `${safeTitle}.json`,
      contentType: "application/json; charset=utf-8",
      body,
    };
  }

  if (format === "pdf") {
    const pdfBuffer = await renderConversationPdf(conv, msgRows, runRows);
    return {
      format,
      filename: `${safeTitle}.pdf`,
      contentType: "application/pdf",
      body: pdfBuffer.toString("base64"),
      encoding: "base64",
    };
  }

  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push("");
  lines.push(`*Exported: ${new Date().toISOString()}*  `);
  lines.push(`*Created: ${conv.createdAt}*  `);
  if (conv.modelName) lines.push(`*Model: \`${conv.modelName}\`*`);
  lines.push("");
  for (const m of msgRows) {
    const ts = new Date(m.createdAt).toISOString();
    lines.push(`## ${m.role} — ${ts}`);
    lines.push("");
    lines.push(m.content);
    lines.push("");
  }
  if (runRows.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Agent runs");
    lines.push("");
    for (const r of runRows) {
      lines.push(`### ${r.goal}`);
      lines.push("");
      lines.push(`- Status: \`${r.status}\``);
      if (r.summary) lines.push(`- Summary: ${r.summary}`);
      if (r.plan) {
        lines.push("- Plan:");
        for (const planLine of r.plan.split("\n")) lines.push(`  - ${planLine}`);
      }
      lines.push("");
    }
  }

  return {
    format,
    filename: `${safeTitle}.md`,
    contentType: "text/markdown; charset=utf-8",
    body: lines.join("\n"),
  };
}

async function renderConversationPdf(
  conv: ConversationRow,
  msgRows: Array<typeof messagesTable.$inferSelect>,
  runRows: Array<typeof agentRuns.$inferSelect>,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 48, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(20).text(conv.title, { underline: false });
      doc
        .fontSize(9)
        .fillColor("#666")
        .text(`Exported ${new Date().toISOString()}`)
        .text(`Created ${conv.createdAt}`);
      if (conv.modelName) doc.text(`Model: ${conv.modelName}`);
      doc.moveDown().fillColor("#000");

      for (const m of msgRows) {
        const ts = new Date(m.createdAt).toISOString();
        doc.fontSize(11).fillColor("#444").text(`${m.role.toUpperCase()} — ${ts}`);
        doc.fontSize(11).fillColor("#000").text(m.content, { paragraphGap: 6 });
        doc.moveDown(0.3);
      }

      if (runRows.length > 0) {
        doc.addPage();
        doc.fontSize(16).text("Agent runs");
        doc.moveDown();
        for (const r of runRows) {
          doc.fontSize(12).fillColor("#000").text(r.goal);
          doc.fontSize(9).fillColor("#666").text(`Status: ${r.status}`);
          if (r.summary) {
            doc.fillColor("#000").fontSize(10).text(r.summary, { paragraphGap: 4 });
          }
          if (r.plan) {
            doc.fontSize(9).fillColor("#444").text(r.plan, { paragraphGap: 4 });
          }
          doc.moveDown(0.5);
        }
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Mark a conversation as having involved desktop control. Called by the
 * agent service whenever a desktop-routed run is created against a
 * conversation. Used by the "desktop control involved" filter on the
 * sidebar list.
 */
export async function markDesktopUsed(
  ctx: TenantContext,
  conversationId: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ desktopUsed: 1, updatedAt: Date.now() })
    .where(
      and(
        tenantScope(ctx, conversations),
        eq(conversations.id, conversationId),
      ),
    );
}

/**
 * Bump `lastMessageAt` / preview / messageCount when an agent run logs a
 * message of its own (so the sidebar reflects activity even when the user
 * is staring at the agent transcript).
 */
export async function touchConversation(
  ctx: TenantContext,
  conversationId: string,
  preview: string,
  delta: number = 1,
): Promise<void> {
  const existing = await getConversation(ctx, conversationId);
  if (!existing) return;
  const now = Date.now();
  await db
    .update(conversations)
    .set({
      lastMessageAt: now,
      lastMessagePreview: toPreview(preview),
      messageCount: existing.messageCount + delta,
      updatedAt: now,
    })
    .where(
      and(
        tenantScope(ctx, conversations),
        eq(conversations.id, conversationId),
      ),
    );
}
