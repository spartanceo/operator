/**
 * Context window management & rolling summarisation (Task #51).
 *
 * Every local model has a finite context window — Llama 3.1 8B at 128k
 * tokens, smaller models as low as 4k. This service is the single source
 * of truth for:
 *
 *   1. Token counting   — A char/4 heuristic that is cheap, deterministic,
 *                         and within ±15 % of true tokens for the
 *                         tokenizers shipped by the supported runtimes.
 *                         Good enough to drive percent-of-window UI and
 *                         the summarisation trigger; we are not trying
 *                         to bill against it.
 *
 *   2. Per-model context window resolution
 *                       — Looks up the active model's advertised window.
 *                         Falls back to a conservative 4k for unknown
 *                         models so we never silently overflow.
 *
 *   3. Building the chat prompt
 *                       — Pulls the conversation transcript honouring
 *                         pinned messages, prior summaries, and the
 *                         user's explicit context-reset cutoff. Returns
 *                         the messages that will actually be sent to the
 *                         model along with a usage envelope.
 *
 *   4. Rolling summarisation
 *                       — When the prompt would exceed `summariseAtPct`
 *                         (default 75) of the window, the oldest
 *                         non-pinned non-summary messages are compressed
 *                         into a single new "is_summary=1" message via
 *                         the active runtime. The conversation's
 *                         `summarised_through_ts` high-water-mark is
 *                         advanced so subsequent prompts skip the
 *                         verbose history.
 *
 *   5. Long document chunking
 *                       — `chunkLongInput` splits oversize input into
 *                         model-fit segments so callers can process them
 *                         sequentially rather than crashing on overflow.
 *
 * Design notes:
 *   - Pure functions where possible; only `runRollingSummarisation` and
 *     `loadContextMessages` touch the database.
 *   - `OverflowError` is the structured failure raised by `prepareChatContext`
 *     when even after summarisation the request will not fit. The chat
 *     route translates it into a 413 with actionable copy.
 *   - All summary calls go through `runtime.service` — they cost real
 *     tokens, so we intentionally cap reserved-output and skip
 *     summarisation when the runtime has no chat capability.
 */
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  conversations,
  db,
  messages as messagesTable,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { retrieveContext } from "./kb.service";
import {
  CloudConsentRequiredError,
  CloudCredentialMissingError,
  RuntimeUnavailableError,
  chatWithActiveRuntime,
} from "./runtime.service";

/** Conservative default window in tokens for unknown models. */
export const DEFAULT_CONTEXT_WINDOW = 4_096;

/** Reserved budget for the model's reply (kept out of input headroom). */
export const DEFAULT_OUTPUT_RESERVE = 1_024;

/** Default summarisation trigger as a fraction of the input headroom. */
export const DEFAULT_SUMMARISE_PCT = 75;

/** Visual amber threshold (matches the chat UI). */
export const AMBER_PCT = 70;

/** Visual red threshold (matches the chat UI). */
export const RED_PCT = 90;

/**
 * Per-model context window table. Family / size are matched
 * loosely against `model.toLowerCase()` so e.g. `llama3:8b-instruct`
 * resolves the same as `llama3.1:8b`. Numbers reflect each family's
 * advertised maximum context window — Standard 13: explicit defaults.
 *
 * Tier-review: bounded — fixed list, mutated only via code change.
 */
const MODEL_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/llama-?3\.?2/, 128_000],
  [/llama-?3\.?1/, 128_000],
  [/llama-?3/, 8_192],
  [/llama-?2/, 4_096],
  [/mistral-?(small|medium|large)/, 32_768],
  [/mistral/, 8_192],
  [/mixtral/, 32_768],
  [/qwen-?2\.?5/, 128_000],
  [/qwen/, 32_768],
  [/phi-?3/, 128_000],
  [/phi/, 4_096],
  [/gemma-?2/, 8_192],
  [/gemma/, 8_192],
  [/codellama/, 16_384],
  [/deepseek-?coder/, 16_384],
  [/deepseek/, 32_768],
  [/gpt-?4o/, 128_000],
  [/gpt-?4-turbo/, 128_000],
  [/gpt-?4/, 8_192],
  [/gpt-?3\.?5/, 16_385],
  [/claude-?3\.?5/, 200_000],
  [/claude-?3/, 200_000],
  [/claude/, 100_000],
];

/**
 * Resolve the advertised context window (in tokens) for a model id. An
 * unknown id resolves to `DEFAULT_CONTEXT_WINDOW` so the system never
 * silently overflows.
 */
export function getContextWindowFor(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const lower = model.toLowerCase();
  for (const [pattern, window] of MODEL_WINDOWS) {
    if (pattern.test(lower)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Cheap char/4 token heuristic. The ratio is what every well-known
 * tokenizer-free estimator uses (BPE tokens average ~4 chars in
 * English). Good enough for triggering summarisation; not a billing
 * source.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(
  messages: ReadonlyArray<{ role: string; content: string }>,
): number {
  // Each message has a small per-turn overhead for role tags + delimiters
  // that real tokenisers add (~4 tokens per message on ChatML-style
  // formats). Including it keeps the estimate closer to the runtime's
  // own count.
  let total = 0;
  for (const m of messages) {
    total += 4 + estimateTokens(m.content);
  }
  return total;
}

export interface ContextUsage {
  contextWindow: number;
  usedTokens: number;
  /** Headroom = contextWindow - reservedOutput. */
  inputBudget: number;
  /** usedTokens / inputBudget * 100, clamped to [0,200]. */
  pct: number;
  /** Threshold beyond which rolling summarisation kicks in. */
  summariseAtPct: number;
  status: "ok" | "amber" | "red" | "overflow";
  hasSummary: boolean;
  pinnedCount: number;
  /** Total messages currently sent to the model (post-trim). */
  effectiveMessageCount: number;
  /** Total messages stored on the conversation. */
  storedMessageCount: number;
}

export interface ContextMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  pinned: boolean;
  isSummary: boolean;
}

/**
 * Load the messages for a conversation that participate in the *active*
 * context: pinned messages (always), prior summaries (always), and any
 * verbose message newer than both `summarised_through_ts` and
 * `context_reset_ts`. Ordered ascending by createdAt so the array can
 * be forwarded to the runtime as-is.
 */
export async function loadContextMessages(
  ctx: TenantContext,
  conversationId: string,
): Promise<{
  messages: ContextMessage[];
  storedCount: number;
  summarisedThroughTs: number | null;
  contextResetTs: number | null;
}> {
  const convRows = await db
    .select({
      summarisedThroughTs: conversations.summarisedThroughTs,
      contextResetTs: conversations.contextResetTs,
      messageCount: conversations.messageCount,
    })
    .from(conversations)
    .where(and(tenantScope(ctx, conversations), eq(conversations.id, conversationId)))
    .limit(1);
  const conv = convRows[0];
  if (!conv) {
    return { messages: [], storedCount: 0, summarisedThroughTs: null, contextResetTs: null };
  }
  const cutoff = Math.max(conv.summarisedThroughTs ?? 0, conv.contextResetTs ?? 0);
  const rows = await db
    .select({
      id: messagesTable.id,
      role: messagesTable.role,
      content: messagesTable.content,
      createdAt: messagesTable.createdAt,
      pinned: messagesTable.pinned,
      isSummary: messagesTable.isSummary,
    })
    .from(messagesTable)
    .where(
      and(
        tenantScope(ctx, messagesTable),
        eq(messagesTable.conversationId, conversationId),
      ),
    )
    .orderBy(asc(messagesTable.createdAt));

  const filtered: ContextMessage[] = [];
  for (const r of rows) {
    const pinned = Boolean(r.pinned);
    const isSummary = Boolean(r.isSummary);
    if (!pinned && !isSummary && r.createdAt <= cutoff) continue;
    filtered.push({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt,
      pinned,
      isSummary,
    });
  }
  return {
    messages: filtered,
    storedCount: conv.messageCount,
    summarisedThroughTs: conv.summarisedThroughTs,
    contextResetTs: conv.contextResetTs,
  };
}

export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Compute the current usage envelope for a set of context messages
 * (typically the result of `loadContextMessages` plus any pending
 * user input). Pure — does not touch the database.
 */
export function computeUsage(
  ctxMessages: ReadonlyArray<ContextMessage>,
  pendingInput: string | null,
  model: string | null,
  options: { outputReserveTokens?: number; summariseAtPct?: number } = {},
): ContextUsage {
  const window = getContextWindowFor(model);
  const reserve = options.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE;
  const inputBudget = Math.max(window - reserve, Math.floor(window / 2));
  const summariseAtPct = options.summariseAtPct ?? DEFAULT_SUMMARISE_PCT;
  const baseTokens = estimateMessagesTokens(ctxMessages);
  const pendingTokens = pendingInput ? 4 + estimateTokens(pendingInput) : 0;
  const used = baseTokens + pendingTokens;
  const pct = inputBudget > 0 ? Math.round((used / inputBudget) * 100) : 0;
  const status: ContextUsage["status"] =
    pct >= 100 ? "overflow" : pct >= RED_PCT ? "red" : pct >= AMBER_PCT ? "amber" : "ok";
  return {
    contextWindow: window,
    usedTokens: used,
    inputBudget,
    pct: Math.min(pct, 200),
    summariseAtPct,
    status,
    hasSummary: ctxMessages.some((m) => m.isSummary),
    pinnedCount: ctxMessages.filter((m) => m.pinned).length,
    effectiveMessageCount: ctxMessages.length,
    storedMessageCount: ctxMessages.length,
  };
}

export class OverflowError extends Error {
  readonly code = "CONTEXT_OVERFLOW";
  constructor(
    public readonly usage: ContextUsage,
    public readonly suggestion: string,
  ) {
    super(`Prompt exceeds context budget (${usage.usedTokens}/${usage.inputBudget})`);
  }
}

/** Result of preparing a chat call. */
export interface PreparedContext {
  messages: ChatTurn[];
  usage: ContextUsage;
  /** True when this call triggered fresh summarisation. */
  summarisedThisCall: boolean;
  /** Number of verbose messages folded into the new summary, if any. */
  compressedMessageCount: number;
  /**
   * Document titles retrieved from the knowledge base for this turn.
   * Empty when no relevant KB content was found.
   */
  kbSources: string[];
}

/**
 * Compress the oldest non-pinned non-summary messages until the prompt
 * fits below `summariseAtPct`. Inserts a single summary message at the
 * boundary timestamp and advances the conversation's
 * `summarised_through_ts`. The active runtime is used to generate the
 * summary text — if it fails we fall back to a deterministic
 * concatenation so the conversation never gets stuck.
 */
async function rollingSummariseInPlace(
  ctx: TenantContext,
  conversationId: string,
  ctxMessages: ContextMessage[],
  pendingInput: string | null,
  model: string | null,
  options: { outputReserveTokens?: number; summariseAtPct?: number },
  confirmedRuntimeIds: ReadonlyArray<string>,
): Promise<{ usage: ContextUsage; compressed: number }> {
  const reserve = options.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE;
  const summariseAtPct = options.summariseAtPct ?? DEFAULT_SUMMARISE_PCT;
  const window = getContextWindowFor(model);
  const inputBudget = Math.max(window - reserve, Math.floor(window / 2));
  const targetTokens = Math.floor(inputBudget * (summariseAtPct / 100));

  // Walk the messages in chronological order, peeling off the oldest
  // *eligible* (non-pinned, non-summary) ones until the projected total
  // tokens (remaining + summary placeholder + pending input) fits below
  // the trigger threshold. We always leave at least the most recent
  // non-pinned message in place so the model has a current anchor.
  const eligibleIdx: number[] = [];
  for (let i = 0; i < ctxMessages.length; i += 1) {
    const m = ctxMessages[i]!;
    if (!m.pinned && !m.isSummary) eligibleIdx.push(i);
  }
  if (eligibleIdx.length < 2) {
    // Nothing useful to compress.
    const usage = computeUsage(ctxMessages, pendingInput, model, options);
    return { usage, compressed: 0 };
  }

  const SUMMARY_TOKEN_BUDGET = Math.min(800, Math.floor(targetTokens / 4));
  let compressedCount = 0;
  const toCompress: ContextMessage[] = [];

  // Stop one before the last eligible so we keep a current anchor.
  const stopBefore = eligibleIdx[eligibleIdx.length - 1]!;

  for (const idx of eligibleIdx) {
    if (idx >= stopBefore) break;
    toCompress.push(ctxMessages[idx]!);
    compressedCount += 1;
    const remaining = ctxMessages.filter((_, i) => i > idx || ctxMessages[i]!.pinned || ctxMessages[i]!.isSummary || i === stopBefore)
      .filter((m) => !toCompress.includes(m));
    const projected = estimateMessagesTokens(remaining) + SUMMARY_TOKEN_BUDGET +
      (pendingInput ? 4 + estimateTokens(pendingInput) : 0);
    if (projected <= targetTokens) break;
  }

  if (toCompress.length === 0) {
    const usage = computeUsage(ctxMessages, pendingInput, model, options);
    return { usage, compressed: 0 };
  }

  const cutoffTs = toCompress[toCompress.length - 1]!.createdAt;

  // Build a deterministic fallback summary first; we use it if the
  // runtime call fails or returns empty content.
  const fallback = buildDeterministicSummary(toCompress);

  let summaryText = fallback;
  try {
    const summaryPrompt: ChatTurn[] = [
      {
        role: "system",
        content:
          "You are summarising the earlier portion of a chat conversation so the assistant can stay within its context window. " +
          "Produce a concise, faithful summary in 4-8 bullet points capturing decisions, requirements, named entities, and any open questions. " +
          "Do not invent information. Do not include a preamble.",
      },
      {
        role: "user",
        content: `Summarise the following conversation excerpts:\n\n${toCompress
          .map((m) => `[${m.role}] ${m.content}`)
          .join("\n\n")}`,
      },
    ];
    const result = await chatWithActiveRuntime(
      ctx,
      { model: model ?? "", messages: summaryPrompt, temperature: 0.2 },
      [...confirmedRuntimeIds],
    );
    if (result.message.content.trim().length > 0) {
      summaryText = result.message.content.trim();
    }
  } catch (e) {
    if (
      e instanceof CloudConsentRequiredError ||
      e instanceof CloudCredentialMissingError ||
      e instanceof RuntimeUnavailableError
    ) {
      // Cloud consent missing / runtime offline — fall back to the
      // deterministic concatenation summary so the user can still chat.
      logger.warn(
        { runtimeError: e.code, conversationId },
        "Rolling summary fell back to deterministic summary",
      );
    } else {
      logger.error(
        { err: e instanceof Error ? e.message : String(e), conversationId },
        "Rolling summarisation failed unexpectedly — using deterministic fallback",
      );
    }
  }

  const summaryId = `msg_${nanoid()}`;
  await db.insert(messagesTable).values(
    withTenantValues(ctx, {
      id: summaryId,
      conversationId,
      role: "system",
      content: summaryText,
      isSummary: 1,
      // Place the summary at exactly the cutoff timestamp so it sorts
      // immediately after the messages it replaces.
      createdAt: cutoffTs,
    }),
  );

  await db
    .update(conversations)
    .set({ summarisedThroughTs: cutoffTs, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, conversations), eq(conversations.id, conversationId)));

  // Rebuild the in-memory window so the caller can compute usage
  // without re-querying.
  const compressedIds = new Set(toCompress.map((m) => m.id));
  const rebuilt: ContextMessage[] = ctxMessages.filter((m) => !compressedIds.has(m.id));
  const summaryMsg: ContextMessage = {
    id: summaryId,
    role: "system",
    content: summaryText,
    createdAt: cutoffTs,
    pinned: false,
    isSummary: true,
  };
  rebuilt.push(summaryMsg);
  rebuilt.sort((a, b) => a.createdAt - b.createdAt);

  // Mutate the caller's array so subsequent code sees the new state.
  ctxMessages.length = 0;
  ctxMessages.push(...rebuilt);

  const usage = computeUsage(ctxMessages, pendingInput, model, options);
  return { usage, compressed: toCompress.length };
}

function buildDeterministicSummary(msgs: ReadonlyArray<ContextMessage>): string {
  const lines: string[] = [
    "Earlier conversation summary (auto-generated, runtime summary unavailable):",
  ];
  for (const m of msgs) {
    const trimmed = m.content.trim().replace(/\s+/g, " ").slice(0, 240);
    lines.push(`- [${m.role}] ${trimmed}${m.content.length > 240 ? "…" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Silently retrieves relevant knowledge-base snippets for `query` and
 * returns a system-role ChatTurn to prepend to the prompt. Returns
 * `null` when the KB is empty, has no relevant hits, or the search
 * throws — so callers never have to guard against failures here.
 */
async function tryGetKbContext(
  ctx: TenantContext,
  query: string,
): Promise<{ turn: ChatTurn; titles: string[] } | null> {
  try {
    const kb = await retrieveContext(ctx, query, { limit: 4 });
    if (kb.hits.length === 0) return null;
    const titles = [...new Set(kb.hits.map((h) => h.documentTitle))];
    return {
      turn: {
        role: "system",
        content:
          `The following snippets were retrieved from the user's personal knowledge base and are relevant to their message. ` +
          `Use them to inform your response where appropriate:\n\n${kb.summary}`,
      },
      titles,
    };
  } catch {
    return null;
  }
}

/**
 * Public entry-point used by `/api/chat`. Loads the conversation's
 * active context, applies rolling summarisation if the prompt would
 * trigger the threshold, and returns the messages-to-send envelope.
 *
 * If even after summarisation the prompt cannot fit, raises
 * `OverflowError` so the route can return a 413 with actionable copy.
 */
export async function prepareChatContext(
  ctx: TenantContext,
  conversationId: string | null,
  pendingInput: string,
  model: string | null,
  confirmedRuntimeIds: ReadonlyArray<string>,
  options: { outputReserveTokens?: number; summariseAtPct?: number } = {},
): Promise<PreparedContext> {
  if (!conversationId) {
    // Single-shot chat with no conversation — nothing to summarise.
    const usage = computeUsage([], pendingInput, model, options);
    if (usage.status === "overflow") {
      throw new OverflowError(
        usage,
        "Your message alone is larger than the model's context window. Switch to a model with a larger window or split the message into smaller pieces.",
      );
    }
    const kbResult = await tryGetKbContext(ctx, pendingInput);
    const messages: ChatTurn[] = [];
    if (kbResult) messages.push(kbResult.turn);
    messages.push({ role: "user", content: pendingInput });
    return {
      messages,
      usage,
      summarisedThisCall: false,
      compressedMessageCount: 0,
      kbSources: kbResult?.titles ?? [],
    };
  }

  const loaded = await loadContextMessages(ctx, conversationId);
  let ctxMessages = [...loaded.messages];
  let usage = computeUsage(ctxMessages, pendingInput, model, options);
  let compressed = 0;
  let summarisedThisCall = false;

  if (usage.pct >= (options.summariseAtPct ?? DEFAULT_SUMMARISE_PCT)) {
    const result = await rollingSummariseInPlace(
      ctx,
      conversationId,
      ctxMessages,
      pendingInput,
      model,
      options,
      confirmedRuntimeIds,
    );
    usage = result.usage;
    compressed = result.compressed;
    summarisedThisCall = compressed > 0;
  }

  if (usage.status === "overflow") {
    throw new OverflowError(
      usage,
      compressed > 0
        ? "Even after compressing earlier turns the prompt is too large for this model. Try chunking your input, switching to a model with a larger context window, or starting a fresh context."
        : "Your input is too large to fit in this model's context window. Split it into smaller pieces or switch to a model with a larger window.",
    );
  }

  const turns: ChatTurn[] = ctxMessages
    .filter((m) =>
      m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "tool",
    )
    .map((m) => ({
      role: m.role as ChatTurn["role"],
      content: m.content,
    }));

  // Retrieve relevant knowledge and inject as a leading system message
  // so the model always sees it before the conversation history.
  const kbResult = await tryGetKbContext(ctx, pendingInput);
  if (kbResult) turns.unshift(kbResult.turn);

  turns.push({ role: "user", content: pendingInput });

  return {
    messages: turns,
    usage,
    summarisedThisCall,
    compressedMessageCount: compressed,
    kbSources: kbResult?.titles ?? [],
  };
}

/**
 * Get the current usage envelope without sending anything — drives the
 * subtle context bar in the chat UI.
 */
export async function getConversationContextUsage(
  ctx: TenantContext,
  conversationId: string,
  model: string | null,
  pendingInput: string | null,
  options: { outputReserveTokens?: number; summariseAtPct?: number } = {},
): Promise<ContextUsage> {
  const loaded = await loadContextMessages(ctx, conversationId);
  return computeUsage(loaded.messages, pendingInput, model, options);
}

/** Result envelope for `chunkLongInput`. */
export interface InputChunk {
  index: number;
  total: number;
  content: string;
  estimatedTokens: number;
}

/**
 * Split an oversize user input into model-fit chunks. Splits on
 * paragraph boundaries when possible, falling back to hard slices when
 * a single paragraph is itself larger than the chunk budget. Designed
 * for ingesting large documents (KB ingestion, file paste) without
 * crashing on context overflow.
 */
export function chunkLongInput(
  input: string,
  model: string | null,
  options: { outputReserveTokens?: number; chunkOverlapTokens?: number } = {},
): InputChunk[] {
  const window = getContextWindowFor(model);
  const reserve = options.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE;
  const overlap = Math.max(0, options.chunkOverlapTokens ?? 0);
  // Each chunk is sent as a single user turn with system prompt
  // overhead — leave ~25 % headroom for prompts and the model reply.
  const inputBudget = Math.max(window - reserve, Math.floor(window / 2));
  const perChunkTokens = Math.max(256, Math.floor(inputBudget * 0.6));
  const perChunkChars = perChunkTokens * 4;
  const overlapChars = overlap * 4;

  if (estimateTokens(input) <= perChunkTokens) {
    return [
      {
        index: 0,
        total: 1,
        content: input,
        estimatedTokens: estimateTokens(input),
      },
    ];
  }

  const paragraphs = input.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length <= perChunkChars) {
      buf = candidate;
      continue;
    }
    if (buf) chunks.push(buf);
    if (p.length <= perChunkChars) {
      buf = p;
    } else {
      // Single paragraph too large — hard-slice it.
      let i = 0;
      while (i < p.length) {
        const slice = p.slice(i, i + perChunkChars);
        chunks.push(slice);
        if (i + perChunkChars >= p.length) {
          buf = "";
          break;
        }
        i += perChunkChars - overlapChars;
      }
      buf = "";
    }
  }
  if (buf) chunks.push(buf);

  return chunks.map((content, i) => ({
    index: i,
    total: chunks.length,
    content,
    estimatedTokens: estimateTokens(content),
  }));
}

/**
 * Reset a conversation's active context. Stamps `context_reset_ts` to
 * "now" so the previous transcript is excluded from the LLM prompt
 * while remaining visible in the UI. Pinned messages are kept in the
 * active context regardless.
 */
export async function resetConversationContext(
  ctx: TenantContext,
  conversationId: string,
): Promise<{ contextResetTs: number }> {
  const now = Date.now();
  await db
    .update(conversations)
    .set({ contextResetTs: now, updatedAt: now })
    .where(and(tenantScope(ctx, conversations), eq(conversations.id, conversationId)));
  return { contextResetTs: now };
}

/** Pin or unpin a message — pinned messages are never compressed. */
export async function setMessagePin(
  ctx: TenantContext,
  conversationId: string,
  messageId: string,
  pinned: boolean,
): Promise<{ id: string; pinned: boolean; pinnedAt: number | null } | null> {
  const existing = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        tenantScope(ctx, messagesTable),
        eq(messagesTable.conversationId, conversationId),
        eq(messagesTable.id, messageId),
      ),
    )
    .limit(1);
  if (!existing[0]) return null;
  const now = Date.now();
  await db
    .update(messagesTable)
    .set({
      pinned: pinned ? 1 : 0,
      pinnedAt: pinned ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        tenantScope(ctx, messagesTable),
        eq(messagesTable.id, messageId),
      ),
    );
  return { id: messageId, pinned, pinnedAt: pinned ? now : null };
}

// Re-export helpers used by adjacent modules and tests.
export { gt, lte };
