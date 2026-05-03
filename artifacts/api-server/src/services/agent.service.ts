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

import { emitOpEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { invokeTool, getToolByName } from "./tools.service";
import {
  recordStepComplete,
  recordStepStart,
} from "./crash-recovery.service";
import { listMemories, retrieveRelevantMemories } from "./memory.service";
import { logPrivacyEvent } from "./privacy.service";
import { retrieveContext as retrieveKbContext } from "./kb.service";
import {
  markDesktopUsed,
  touchConversation,
} from "./conversation.service";
import { getSkill, matchSkillForGoal, type SkillRow } from "./skill.service";
import {
  checkPremiumAccess,
  consumePreview,
  recordUsage,
} from "./subscription.service";
import {
  assertSkillConfigured,
  SkillNotConfiguredError,
} from "./skill-config.service";

export interface AgentRunRow {
  id: string;
  goal: string;
  status: string;
  plan: string | null;
  summary: string | null;
  error: string | null;
  modelName: string | null;
  routedSkillId: string | null;
  routedSkillName: string | null;
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
  /**
   * Optional conversation thread to attach this run to. Supplied by the
   * chat UI so subsequent runs in the same thread share a sidebar entry,
   * are searchable together, and export as one markdown file (Task #41).
   */
  conversationId?: string;
  /** When set, the Router uses this skill explicitly (skip trigger matching). */
  skillId?: string;
  /**
   * Optional queue task id (Task #58). When supplied, every executor step
   * is checkpointed to `task_checkpoints` so a hard crash leaves a
   * resumable record. Read-only steps flush asynchronously, destructive
   * steps synchronously, see crash-recovery.service for the policy.
   */
  queueTaskId?: string;
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
    routedSkillId: r.routedSkillId,
    routedSkillName: r.routedSkillName,
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

type RouterDecision = "planner" | "research" | "memory" | "skill" | "desktop";

/**
 * Router classifier — picks the downstream agent for a goal.
 *
 * Tier 1 uses a deterministic keyword router. An installed skill match
 * short-circuits to the skill branch; otherwise desktop intents route to
 * the dedicated `/desktop` orchestrator. The agent loop records the
 * intent + redirect in the plan so the audit trail still shows the
 * routing decision even when the actual execution lives in another
 * service.
 */
function routerAgent(goal: string, hasSkill: boolean): RouterDecision {
  if (hasSkill) return "skill";
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

  // Skill resolution — explicit id wins; otherwise the Router consults
  // installed skills to find a trigger match.
  let activeSkill: SkillRow | null = null;
  if (input.skillId) {
    activeSkill = await getSkill(ctx, input.skillId);
  } else {
    activeSkill = await matchSkillForGoal(ctx, input.goal);
  }

  // Premium gating (Task #6) — when the resolved skill is paid we check
  // the subscription + preview counter before letting the orchestrator
  // inject its content. A denied premium skill drops back to a no-skill
  // run and surfaces a permission card via a system message.
  let premiumDecision: Awaited<ReturnType<typeof checkPremiumAccess>> | null = null;
  let premiumSkillForLogging: { id: string; slug: string; author: string } | null = null;
  if (activeSkill) {
    premiumDecision = await checkPremiumAccess(ctx, {
      skillId: activeSkill.id,
      slug: activeSkill.slug,
      isPremium: activeSkill.isPremium,
      previewUsesAllowed: activeSkill.previewUsesAllowed,
      creatorHandle: activeSkill.author,
    });
    if (activeSkill.isPremium) {
      premiumSkillForLogging = {
        id: activeSkill.id,
        slug: activeSkill.slug,
        author: activeSkill.author,
      };
    }
    if (activeSkill.isPremium && !premiumDecision.allowed) {
      // Drop the skill — the user must subscribe before it can be injected.
      await logPrivacyEvent(ctx, {
        eventType: "skill.permission.denied",
        actor: ctx.userId ?? ctx.tenantId,
        target: activeSkill.id,
        severity: "info",
        detail:
          `slug=${activeSkill.slug} reason=${premiumDecision.reason} ` +
          `previewsUsed=${premiumDecision.previewsUsed}`,
      });
      activeSkill = null;
    }
  }

  // First-run gate (Task #43). When the resolved skill declares any
  // required configuration fields that the user has not supplied yet,
  // refuse to start the run — the UI catches `SKILL_NOT_CONFIGURED`
  // and pops the configuration panel before retrying. We only enforce
  // the gate for explicit `skillId` invocations: an auto-routed skill
  // that is unconfigured silently falls through to the generic Router
  // so the user is never blocked for a skill they did not pick.
  if (activeSkill && input.skillId) {
    await assertSkillConfigured(ctx, activeSkill.id);
  } else if (activeSkill && !input.skillId) {
    try {
      await assertSkillConfigured(ctx, activeSkill.id);
    } catch (e) {
      if (e instanceof SkillNotConfiguredError) {
        logger.info(
          { skillId: activeSkill.id, missing: e.missingKeys },
          "Auto-routed skill skipped — required configuration missing",
        );
        activeSkill = null;
      } else {
        throw e;
      }
    }
  }

  const route = routerAgent(input.goal, activeSkill !== null);
  let memorySummary = route === "memory" ? await memoryAgent(ctx) : null;
  // Always inject top relevant long-term memories as soft context, even when
  // the router did not pick the dedicated memory agent. Best-effort: failures
  // do not abort the run.
  try {
    const relevant = await retrieveRelevantMemories(ctx, input.goal, { limit: 3 });
    if (relevant.length > 0) {
      const recallLine = relevant
        .map((m) => `• [${m.confidence}] ${m.title}: ${m.content}`)
        .join("\n");
      memorySummary = memorySummary
        ? `${memorySummary}\n\nRelevant recall:\n${recallLine}`
        : `Relevant recall:\n${recallLine}`;
    }
  } catch {
    // best-effort; ignore
  }
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
      routedSkillId: activeSkill?.id ?? null,
      routedSkillName: activeSkill?.name ?? null,
      startedAt,
      conversationId: input.conversationId ?? null,
    }),
  );

  emitOpEvent(ctx, "task_started", {
    runId: id,
    goal: input.goal,
    skill: activeSkill?.slug ?? null,
    route,
  });

  await db.insert(messagesTable).values(
    withTenantValues(ctx, {
      id: `msg_${nanoid()}`,
      runId: id,
      role: "user",
      content: input.goal,
      conversationId: input.conversationId ?? null,
    }),
  );

  if (input.conversationId) {
    await touchConversation(ctx, input.conversationId, input.goal, 1);
    if (route === "desktop") {
      await markDesktopUsed(ctx, input.conversationId);
    }
  }
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
  if (activeSkill) {
    const banner =
      premiumDecision && activeSkill.isPremium
        ? premiumDecision.reason === "preview"
          ? `Premium skill preview ${premiumDecision.previewsUsed + 1}/${activeSkill.previewUsesAllowed} — subscribe at /subscription to keep using it.\n`
          : premiumDecision.reason === "subscription"
            ? `Premium skill (covered by your subscription).\n`
            : ""
        : "";
    await db.insert(messagesTable).values(
      withTenantValues(ctx, {
        id: `msg_${nanoid()}`,
        runId: id,
        role: "system",
        content: `${banner}Skill "${activeSkill.name}" (${activeSkill.slug}) injected by Router:\n${activeSkill.content}`,
      }),
    );
    if (activeSkill.isPremium && premiumDecision?.reason === "preview") {
      await consumePreview(ctx, activeSkill.id);
    }
    if (activeSkill.isPremium) {
      await recordUsage(ctx, {
        skillId: activeSkill.id,
        skillSlug: activeSkill.slug,
        creatorHandle: activeSkill.author,
        modelName: input.modelName ?? null,
        runId: id,
        approvedByUser: true,
        wasPreview: premiumDecision?.reason === "preview",
      });
    }
  } else if (premiumSkillForLogging) {
    // Surface the paywall as a system message so the chat UI can render
    // the permission card without an extra round-trip.
    await db.insert(messagesTable).values(
      withTenantValues(ctx, {
        id: `msg_${nanoid()}`,
        runId: id,
        role: "system",
        content:
          `Premium skill "${premiumSkillForLogging.slug}" requires a Creator Pro subscription. ` +
          `Open /subscription to start a checkout, or pick a different skill.`,
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
  for (let stepIndex = 0; stepIndex < plan.length; stepIndex += 1) {
    const step = plan[stepIndex]!;
    const tool = getToolByName(step.toolName);
    const callId = `tc_${nanoid()}`;
    const stepStartedAt = Date.now();
    // Task #58 — write a pre-step checkpoint when the run is bound to a
    // queued task. Destructive steps (high/critical risk) flush
    // synchronously so the row is durable BEFORE the side-effect lands;
    // low/medium risk steps flush asynchronously to keep the loop fast.
    const isDestructive =
      tool?.riskLevel === "high" || tool?.riskLevel === "critical";
    let checkpointId: string | null = null;
    if (input.queueTaskId) {
      const ck = await recordStepStart(ctx, {
        taskId: input.queueTaskId,
        runId: id,
        stepIndex,
        stepKind: `tool:${step.toolName}`,
        destructive: isDestructive,
        inputs: step.input,
        summary: step.rationale,
        requiredToolNames: [step.toolName],
        ...(activeSkill ? { requiredSkillIds: [activeSkill.id] } : {}),
      });
      checkpointId = ck.id;
    }
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
      if (checkpointId) {
        await recordStepComplete(ctx, checkpointId, isDestructive, {
          status: "completed",
          outputs: result.output,
          toolCalls: [{ id: callId, name: step.toolName, status: "completed" }],
        });
      }
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
      if (checkpointId) {
        await recordStepComplete(ctx, checkpointId, isDestructive, {
          status: "failed",
          error: errMsg,
          toolCalls: [{ id: callId, name: step.toolName, status: "failed" }],
        });
      }
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
      conversationId: input.conversationId ?? null,
    }),
  );

  if (input.conversationId) {
    await touchConversation(ctx, input.conversationId, verdict.summary, 1);
  }

  const modelUsed = input.modelName ?? "default";
  const toolNames = outputs.map((o) => o.toolName).join(",") || "none";
  // High-risk tools surface an approval prompt in the UI; we record whether
  // any plan step would have required user approval to satisfy auditability.
  const approvalsTriggered = plan.some((p) => {
    const tool = getToolByName(p.toolName);
    return tool?.riskLevel === "high";
  });

  if (activeSkill) {
    emitOpEvent(ctx, "skill_invoked", {
      runId: id,
      skillId: activeSkill.id,
      slug: activeSkill.slug,
    });
    // Structured invocation receipt: which skill, which model, which tools,
    // and whether approval was triggered. The detail field is a query-friendly
    // single-line key=value list so it can be filtered from the privacy log.
    await logPrivacyEvent(ctx, {
      eventType: "skill.invoke",
      actor: ctx.userId ?? ctx.tenantId,
      target: activeSkill.id,
      severity: "info",
      detail:
        `slug=${activeSkill.slug} runId=${id} model=${modelUsed} ` +
        `tools=${toolNames} approvalsTriggered=${approvalsTriggered} ` +
        `status=${verdict.ok ? "completed" : "failed"}`,
    });
  }

  await logPrivacyEvent(ctx, {
    eventType: "agent.run",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail:
      `route=${route} status=${verdict.ok ? "completed" : "failed"} ` +
      `model=${modelUsed} tools=${toolNames} ` +
      `approvalsTriggered=${approvalsTriggered}` +
      (activeSkill ? ` skill=${activeSkill.slug}` : ""),
  });

  // We resolve the row at the very end so callers see the final state.
  const final = await getAgentRun(ctx, id);
  if (!final) throw new Error("Agent run vanished after creation");
  // startedAt is informational only; surface it so callers don't have to subtract.
  void startedAt;
  emitOpEvent(ctx, verdict.ok ? "task_completed" : "task_failed", {
    runId: id,
    goal: input.goal,
    summary: verdict.summary,
    skill: activeSkill?.slug ?? null,
    durationMs: completedAt - startedAt,
  });
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
