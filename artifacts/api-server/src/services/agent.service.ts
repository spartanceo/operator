/**
 * Agent orchestrator — six deterministic agents wired into a single loop.
 *
 * Tier 1 ships pure-function agents that do not call out to a model; they
 * return predictable plans, executions, and verdicts so the entire route
 * surface (and its tests) work without an LLM. Once Ollama is reachable,
 * the same agents will swap to model-backed implementations behind this
 * orchestrator's API.
 *
 * Agents:
 *   - Router    — picks which downstream agent to call.
 *   - Planner   — turns a goal into an ordered list of steps.
 *   - Executor  — runs the next tool call against the registry.
 *   - Verifier  — checks the executor's output against acceptance criteria.
 *   - Research  — gathers supporting context (Tier 1: deterministic stub).
 *   - Memory    — surfaces relevant memories for the planner.
 *
 * The DB shape: every run has rows in `agent_runs` (lifecycle), `messages`
 * (transcript), and `tool_calls` (every tool the executor invoked). Routes
 * paginate over each table independently.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  agentRuns,
  buildPage,
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

import { logger } from "../lib/logger";
import { invokeTool, getToolByName } from "./tools.service";
import { listMemories } from "./memory.service";
import { logPrivacyEvent } from "./privacy.service";
import { retrieveContext as retrieveKbContext } from "./kb.service";

export interface AgentRunRow {
  id: string;
  goal: string;
  status: string;
  plan: string | null;
  summary: string | null;
  error: string | null;
  modelName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  runId: string | null;
  role: string;
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: string;
}

export interface ToolCallRow {
  id: string;
  runId: string;
  toolName: string;
  status: string;
  riskLevel: string;
  input: string;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface CreateAgentRunInput {
  goal: string;
  modelName?: string;
  /**
   * When true (default), the orchestrator queries the personal knowledge base
   * for snippets relevant to the goal and prepends them to the run as a
   * system message before the planner / executor run. Setting this to
   * `false` skips RAG entirely (used by tests that want a clean transcript).
   */
  useKnowledgeBase?: boolean;
  /** Optional collection scope for RAG retrieval. */
  knowledgeCollectionId?: string;
}

function toRunRow(r: typeof agentRuns.$inferSelect): AgentRunRow {
  return {
    id: r.id,
    goal: r.goal,
    status: r.status,
    plan: r.plan,
    summary: r.summary,
    error: r.error,
    modelName: r.modelName,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toMessageRow(r: typeof messagesTable.$inferSelect): MessageRow {
  return {
    id: r.id,
    runId: r.runId,
    role: r.role,
    content: r.content,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function toToolCallRow(r: typeof toolCallsTable.$inferSelect): ToolCallRow {
  return {
    id: r.id,
    runId: r.runId,
    toolName: r.toolName,
    status: r.status,
    riskLevel: r.riskLevel,
    input: r.input,
    output: r.output,
    error: r.error,
    durationMs: r.durationMs,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

// ─── Deterministic agents ────────────────────────────────────────────────────

interface PlanStep {
  toolName: string;
  input: Record<string, unknown>;
  rationale: string;
}

/**
 * Router classifier — picks the downstream agent for a goal.
 *
 * Tier 1 uses a deterministic keyword router. Desktop intents short-circuit
 * to the dedicated `/desktop` orchestrator; the agent loop records the
 * intent + redirect in the plan so the audit trail still shows the routing
 * decision even when the actual execution lives in another service.
 */
function routerAgent(
  goal: string,
): "planner" | "research" | "memory" | "desktop" {
  const g = goal.toLowerCase();
  if (g.includes("remember") || g.includes("recall")) return "memory";
  if (g.includes("research") || g.includes("look up")) return "research";
  if (
    g.includes("desktop") ||
    g.includes("screen") ||
    g.includes("click ") ||
    g.includes("type ") ||
    g.includes("open application") ||
    g.includes("open the app") ||
    g.includes("press key")
  ) {
    return "desktop";
  }
  return "planner";
}

function desktopRouterNote(goal: string): string {
  return (
    `Goal "${goal}" routed to the desktop control agent. ` +
    `Open /desktop and start a session — the LAV cycle (Look → Act → Verify) ` +
    `will plan and execute with semantic targeting.`
  );
}

function plannerAgent(goal: string): PlanStep[] {
  // Deterministic Tier 1 plan: every goal becomes a 3-step pipeline that
  // exercises clock, echo, and noop. This guarantees the orchestrator path
  // is exercised end-to-end without any model dependency.
  return [
    {
      toolName: "clock.now",
      input: {},
      rationale: "Stamp the run start with a deterministic timestamp.",
    },
    {
      toolName: "echo",
      input: { goal },
      rationale: "Echo the goal back so the verifier can compare it.",
    },
    {
      toolName: "noop",
      input: {},
      rationale: "Final no-op step — keeps the pipeline shape consistent.",
    },
  ];
}

function verifierAgent(
  goal: string,
  outputs: ReadonlyArray<{ toolName: string; output: Record<string, unknown> }>,
): { ok: boolean; summary: string } {
  // Verifier checks that the echo step round-tripped the goal — a cheap
  // determinism test that catches a broken executor / dispatcher wiring.
  const echo = outputs.find((o) => o.toolName === "echo");
  const echoed = (echo?.output["echoed"] as Record<string, unknown> | undefined)?.["goal"];
  const ok = typeof echoed === "string" && echoed === goal;
  return {
    ok,
    summary: ok
      ? `Verified ${outputs.length} step(s); echo round-tripped goal.`
      : `Verification mismatch: echo did not round-trip the goal.`,
  };
}

async function memoryAgent(ctx: TenantContext): Promise<string> {
  const page = await listMemories(ctx, { limit: 5 });
  if (page.items.length === 0) return "No memories on file.";
  return page.items.map((m) => `• ${m.title} (${m.kind})`).join("\n");
}

function researchAgent(goal: string): string {
  return `Research stub: would gather sources for "${goal}" once Tier 2 networking is enabled.`;
}

// ─── Public orchestrator API ─────────────────────────────────────────────────

export async function listAgentRuns(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<AgentRunRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, agentRuns);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(agentRuns.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(agentRuns)
    .where(where)
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRunRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getAgentRun(
  ctx: TenantContext,
  id: string,
): Promise<AgentRunRow | null> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(and(tenantScope(ctx, agentRuns), eq(agentRuns.id, id)))
    .limit(1);
  return rows[0] ? toRunRow(rows[0]) : null;
}

export async function createAgentRun(
  ctx: TenantContext,
  input: CreateAgentRunInput,
): Promise<AgentRunRow> {
  const id = `run_${nanoid()}`;
  const startedAt = Date.now();
  const route = routerAgent(input.goal);
  const memorySummary = route === "memory" ? await memoryAgent(ctx) : null;
  const researchSummary = route === "research" ? researchAgent(input.goal) : null;
  const desktopNote = route === "desktop" ? desktopRouterNote(input.goal) : null;
  // RAG: pull top-k snippets from the personal knowledge base unless the
  // caller explicitly opted out. The retrieve call is best-effort — if the
  // KB is empty or the search throws we still complete the run.
  let knowledgeSummary: string | null = null;
  if (input.useKnowledgeBase !== false) {
    try {
      const ctxPack = await retrieveKbContext(ctx, input.goal, {
        limit: 5,
        ...(input.knowledgeCollectionId
          ? { collectionId: input.knowledgeCollectionId }
          : {}),
      });
      if (ctxPack.hits.length > 0) knowledgeSummary = ctxPack.summary;
    } catch (e) {
      // Don't fail the run because RAG had a bad day — log and move on.
      // Standard 8: external dependencies must never break the core path.
      // eslint-disable-next-line no-console
      console.warn("kb retrieve failed", e);
    }
  }
  const plan = plannerAgent(input.goal);
  const planText =
    (desktopNote ? `${desktopNote}\n` : "") +
    plan.map((p, i) => `${i + 1}. [${p.toolName}] ${p.rationale}`).join("\n");

  await db.insert(agentRuns).values(
    withTenantValues(ctx, {
      id,
      goal: input.goal,
      status: "running",
      plan: planText,
      modelName: input.modelName ?? null,
      startedAt,
    }),
  );

  await db.insert(messagesTable).values(
    withTenantValues(ctx, {
      id: `msg_${nanoid()}`,
      runId: id,
      role: "user",
      content: input.goal,
    }),
  );
  if (knowledgeSummary) {
    await db.insert(messagesTable).values(
      withTenantValues(ctx, {
        id: `msg_${nanoid()}`,
        runId: id,
        role: "system",
        content: `Knowledge base context:\n${knowledgeSummary}`,
      }),
    );
  }
  if (memorySummary) {
    await db.insert(messagesTable).values(
      withTenantValues(ctx, {
        id: `msg_${nanoid()}`,
        runId: id,
        role: "system",
        content: `Memory agent surfaced:\n${memorySummary}`,
      }),
    );
  }
  if (researchSummary) {
    await db.insert(messagesTable).values(
      withTenantValues(ctx, {
        id: `msg_${nanoid()}`,
        runId: id,
        role: "system",
        content: researchSummary,
      }),
    );
  }
  if (desktopNote) {
    await db.insert(messagesTable).values(
      withTenantValues(ctx, {
        id: `msg_${nanoid()}`,
        runId: id,
        role: "system",
        content: desktopNote,
      }),
    );
  }

  // Executor: walk the plan and persist a tool_calls row per step.
  const outputs: Array<{ toolName: string; output: Record<string, unknown> }> = [];
  for (const step of plan) {
    const tool = getToolByName(step.toolName);
    const callId = `tc_${nanoid()}`;
    const stepStartedAt = Date.now();
    try {
      const result = await invokeTool(ctx, step.toolName, step.input);
      outputs.push({ toolName: step.toolName, output: result.output });
      await db.insert(toolCallsTable).values(
        withTenantValues(ctx, {
          id: callId,
          runId: id,
          toolName: step.toolName,
          riskLevel: tool?.riskLevel ?? "low",
          status: "completed",
          input: JSON.stringify(step.input),
          output: JSON.stringify(result.output),
          durationMs: result.durationMs,
          startedAt: stepStartedAt,
          completedAt: Date.now(),
        }),
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, toolName: step.toolName, runId: id }, "Tool call failed");
      await db.insert(toolCallsTable).values(
        withTenantValues(ctx, {
          id: callId,
          runId: id,
          toolName: step.toolName,
          riskLevel: tool?.riskLevel ?? "low",
          status: "failed",
          input: JSON.stringify(step.input),
          error: errMsg,
          startedAt: stepStartedAt,
          completedAt: Date.now(),
        }),
      );
    }
  }

  // Verifier: deterministic check, then close out the run.
  const verdict = verifierAgent(input.goal, outputs);
  const completedAt = Date.now();
  await db
    .update(agentRuns)
    .set({
      status: verdict.ok ? "completed" : "failed",
      summary: verdict.summary,
      completedAt,
      updatedAt: completedAt,
    })
    .where(and(tenantScope(ctx, agentRuns), eq(agentRuns.id, id)));

  await db.insert(messagesTable).values(
    withTenantValues(ctx, {
      id: `msg_${nanoid()}`,
      runId: id,
      role: "assistant",
      content: verdict.summary,
    }),
  );

  await logPrivacyEvent(ctx, {
    eventType: "agent.run",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `route=${route} status=${verdict.ok ? "completed" : "failed"}`,
  });

  // We resolve the row at the very end so callers see the final state.
  const final = await getAgentRun(ctx, id);
  if (!final) throw new Error("Agent run vanished after creation");
  // startedAt is informational only; surface it so callers don't have to subtract.
  void startedAt;
  return final;
}

export async function cancelAgentRun(
  ctx: TenantContext,
  id: string,
): Promise<AgentRunRow | null> {
  const existing = await getAgentRun(ctx, id);
  if (!existing) return null;
  if (existing.status === "completed" || existing.status === "failed") {
    return existing;
  }
  const now = Date.now();
  await db
    .update(agentRuns)
    .set({ status: "cancelled", completedAt: now, updatedAt: now })
    .where(and(tenantScope(ctx, agentRuns), eq(agentRuns.id, id)));
  return getAgentRun(ctx, id);
}

export async function listRunMessages(
  ctx: TenantContext,
  runId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<MessageRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = and(tenantScope(ctx, messagesTable), eq(messagesTable.runId, runId));
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(messagesTable.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(messagesTable)
    .where(where)
    .orderBy(desc(messagesTable.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toMessageRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function listRunToolCalls(
  ctx: TenantContext,
  runId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<ToolCallRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = and(tenantScope(ctx, toolCallsTable), eq(toolCallsTable.runId, runId));
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(toolCallsTable.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(toolCallsTable)
    .where(where)
    .orderBy(desc(toolCallsTable.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toToolCallRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}
