/**
 * Task #50 — Multi-Agent Orchestration Engine.
 *
 * Decomposes a natural-language goal into a directed acyclic graph (DAG)
 * of sub-tasks, dispatches each node to a specialised agent (research,
 * writing, code, desktop, data, communication), runs ready nodes in
 * parallel (within the hardware-tier budget), waits for dependencies,
 * pauses on approval gates, and aggregates the results into a coherent
 * summary plus a "how was this done?" trace.
 *
 * Tier 1 ships pure-function agents that produce deterministic outputs
 * keyed off the goal text. The same orchestrator hooks will swap to
 * model-backed agents once Ollama is reachable — the contract between
 * the runtime and each agent is `(input: Record<string, unknown>) =>
 * Promise<{ output: Record<string, unknown> }>`, which is identical for
 * stub and live implementations.
 *
 * Concurrency policy:
 *   - The DAG executor reads `getHardwareProfile().tier` to choose a
 *     parallelism budget (1 for low, 3 otherwise) and runs every node
 *     whose dependencies are complete in parallel up to that budget.
 *   - Approval-gated nodes pause execution: the entire downstream
 *     subtree waits until `decideOrchestrationApproval()` is called.
 *
 * Depth limit:
 *   - Top-level orchestrations have `depth = 0`. A nested
 *     orchestration spawned by a node lands one deeper. The runtime
 *     refuses to spawn at `depth > MAX_DEPTH` (4) — see
 *     `MAX_ORCHESTRATION_DEPTH`.
 *
 * Failure handling:
 *   - Each node attempts up to `MAX_NODE_ATTEMPTS` times before being
 *     marked `failed`. If the failed node is on the critical path
 *     (every terminal node depends transitively on it), the
 *     orchestration aborts with `status = failed`. Otherwise dependent
 *     nodes are marked `skipped` and the rest of the graph proceeds.
 *
 * Persistence:
 *   - One row in `agent_orchestrations` per DAG; one row in
 *     `orchestration_nodes` per node. State is fully persisted so a
 *     restart leaves a queryable timeline. The runtime is in-process —
 *     a hard crash leaves running nodes stuck in `running` and the
 *     route surface lets the user cancel and retry.
 */
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  agentOrchestrations,
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  orchestrationNodes,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { getHardwareProfile } from "./hardware";

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_ORCHESTRATION_DEPTH = 4;
const MAX_NODE_ATTEMPTS = 2;
const PARALLEL_BUDGET_LOW = 1;
const PARALLEL_BUDGET_HIGH = 3;

// ─── Types ──────────────────────────────────────────────────────────────────

export type AgentType =
  | "research"
  | "writing"
  | "code"
  | "desktop"
  | "data"
  | "communication";

export type OrchestrationStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "skipped";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface DecomposedNode {
  nodeKey: string;
  agentType: AgentType;
  title: string;
  description: string;
  dependsOn: ReadonlyArray<string>;
  input: Record<string, unknown>;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export interface DecomposedPlan {
  goal: string;
  nodes: ReadonlyArray<DecomposedNode>;
}

export interface OrchestrationRow {
  id: string;
  parentOrchestrationId: string | null;
  conversationId: string | null;
  goal: string;
  status: OrchestrationStatus;
  depth: number;
  nodeCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  plan: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationNodeRow {
  id: string;
  orchestrationId: string;
  nodeKey: string;
  agentType: AgentType;
  title: string;
  description: string | null;
  dependsOn: ReadonlyArray<string>;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: NodeStatus;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  approvalDecision: "approved" | "denied" | null;
  attempts: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationDetail extends OrchestrationRow {
  nodes: ReadonlyArray<OrchestrationNodeRow>;
}

export interface CreateOrchestrationInput {
  goal: string;
  conversationId?: string;
  parentOrchestrationId?: string;
  /**
   * Override depth for nested orchestrations. Top-level callers should
   * leave this unset — the runtime defaults to 0 (or `parent.depth + 1`
   * when `parentOrchestrationId` is supplied).
   */
  depth?: number;
}

export interface OrchestrationTraceEntry {
  nodeKey: string;
  agentType: AgentType;
  title: string;
  status: NodeStatus;
  riskLevel: RiskLevel;
  attempts: number;
  durationMs: number | null;
  dependsOn: ReadonlyArray<string>;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
}

export interface OrchestrationTrace {
  orchestrationId: string;
  goal: string;
  status: OrchestrationStatus;
  totalDurationMs: number | null;
  nodes: ReadonlyArray<OrchestrationTraceEntry>;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class OrchestrationDepthExceededError extends Error {
  override readonly name = "OrchestrationDepthExceededError";
  constructor(public readonly depth: number) {
    super(
      `Orchestration depth ${depth} exceeds the maximum of ${MAX_ORCHESTRATION_DEPTH}`,
    );
  }
}

export class OrchestrationDagInvalidError extends Error {
  override readonly name = "OrchestrationDagInvalidError";
  constructor(message: string) {
    super(message);
  }
}

// ─── Decomposition ──────────────────────────────────────────────────────────

interface AgentSpec {
  type: AgentType;
  systemPrompt: string;
  tools: ReadonlyArray<string>;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

const AGENT_REGISTRY: Readonly<Record<AgentType, AgentSpec>> = {
  research: {
    type: "research",
    systemPrompt:
      "You are the Research agent. Gather sources, summarise findings, and return structured notes.",
    tools: ["web.search", "kb.retrieve"],
    riskLevel: "low",
    requiresApproval: false,
  },
  writing: {
    type: "writing",
    systemPrompt:
      "You are the Writing agent. Turn the supplied research notes into a clean, sectioned document.",
    tools: ["files.write"],
    riskLevel: "low",
    requiresApproval: false,
  },
  code: {
    type: "code",
    systemPrompt:
      "You are the Code agent. Generate, edit, or review code in the workspace sandbox.",
    tools: ["files.read", "files.write", "shell.exec"],
    riskLevel: "medium",
    requiresApproval: false,
  },
  desktop: {
    type: "desktop",
    systemPrompt:
      "You are the Desktop Control agent. Use the LAV cycle to operate native applications.",
    tools: ["desktop.click", "desktop.type", "desktop.screenshot"],
    riskLevel: "high",
    requiresApproval: true,
  },
  data: {
    type: "data",
    systemPrompt:
      "You are the Data agent. Query the personal knowledge base, calendars, and files for facts.",
    tools: ["kb.retrieve", "calendar.list", "files.read"],
    riskLevel: "low",
    requiresApproval: false,
  },
  communication: {
    type: "communication",
    systemPrompt:
      "You are the Communication agent. Compose emails, post messages, or place calls.",
    tools: ["email.send", "slack.post", "voip.call"],
    riskLevel: "high",
    requiresApproval: true,
  },
};

export function listBuiltInAgents(): ReadonlyArray<AgentSpec> {
  return Object.values(AGENT_REGISTRY);
}

/**
 * Deterministic Tier-1 task decomposer. Inspects the goal for the
 * keywords each specialised agent claims and emits a DAG that wires
 * them together with reasonable dependencies (research → writing,
 * data → writing, writing → communication).
 *
 * The keyword router is exhaustive enough that simple instructions
 * ("research X and email it to my team") produce the expected three-
 * step graph. Goals that match no specialised keywords fall back to a
 * single research node so the executor still has something to walk.
 */
export function decomposeGoal(goal: string): DecomposedPlan {
  const g = goal.toLowerCase();
  const nodes: DecomposedNode[] = [];

  const wantsResearch =
    /\bresearch|investigate|look up|find out|gather|study\b/.test(g);
  const wantsData =
    /\bcalendar|schedule|inbox|knowledge base|kb |my notes|files?\b/.test(g);
  const wantsCode = /\bcode|script|program|refactor|implement|build (a|the) function|fix the bug\b/.test(
    g,
  );
  const wantsDesktop = /\bdesktop|click|open (the )?app|press|window|browser tab\b/.test(
    g,
  );
  const wantsWriting = /\bwrite|draft|brief|summary|summarise|summarize|report|format|slide|deck|outline|article\b/.test(
    g,
  );
  const wantsComms = /\bemail|send|notify|post|message|slack|call|invite|share\b/.test(g);

  if (wantsResearch) {
    nodes.push({
      nodeKey: "research",
      agentType: "research",
      title: "Research the topic",
      description: `Gather sources and notes for: ${goal}`,
      dependsOn: [],
      input: { goal },
      riskLevel: AGENT_REGISTRY.research.riskLevel,
      requiresApproval: false,
    });
  }

  if (wantsData) {
    nodes.push({
      nodeKey: "data",
      agentType: "data",
      title: "Pull supporting data",
      description: `Query the knowledge base / calendars / files for: ${goal}`,
      dependsOn: [],
      input: { goal },
      riskLevel: AGENT_REGISTRY.data.riskLevel,
      requiresApproval: false,
    });
  }

  if (wantsCode) {
    const deps: string[] = [];
    if (nodes.find((n) => n.nodeKey === "research")) deps.push("research");
    nodes.push({
      nodeKey: "code",
      agentType: "code",
      title: "Generate / edit code",
      description: `Produce code for: ${goal}`,
      dependsOn: deps,
      input: { goal },
      riskLevel: AGENT_REGISTRY.code.riskLevel,
      requiresApproval: false,
    });
  }

  if (wantsWriting) {
    const deps: string[] = [];
    if (nodes.find((n) => n.nodeKey === "research")) deps.push("research");
    if (nodes.find((n) => n.nodeKey === "data")) deps.push("data");
    nodes.push({
      nodeKey: "writing",
      agentType: "writing",
      title: "Write the deliverable",
      description: `Compose the final document for: ${goal}`,
      dependsOn: deps,
      input: { goal },
      riskLevel: AGENT_REGISTRY.writing.riskLevel,
      requiresApproval: false,
    });
  }

  if (wantsDesktop) {
    nodes.push({
      nodeKey: "desktop",
      agentType: "desktop",
      title: "Operate the desktop",
      description: `Drive native UI for: ${goal}`,
      dependsOn: [],
      input: { goal },
      riskLevel: AGENT_REGISTRY.desktop.riskLevel,
      requiresApproval: true,
    });
  }

  if (wantsComms) {
    const deps: string[] = [];
    if (nodes.find((n) => n.nodeKey === "writing")) deps.push("writing");
    else if (nodes.find((n) => n.nodeKey === "research")) deps.push("research");
    nodes.push({
      nodeKey: "communication",
      agentType: "communication",
      title: "Send / post the result",
      description: `Deliver the result via the communication channels in: ${goal}`,
      dependsOn: deps,
      input: { goal },
      riskLevel: AGENT_REGISTRY.communication.riskLevel,
      requiresApproval: true,
    });
  }

  if (nodes.length === 0) {
    nodes.push({
      nodeKey: "research",
      agentType: "research",
      title: "Investigate the request",
      description: `Default research pass for: ${goal}`,
      dependsOn: [],
      input: { goal },
      riskLevel: AGENT_REGISTRY.research.riskLevel,
      requiresApproval: false,
    });
  }

  validateDag(nodes);
  return { goal, nodes };
}

function validateDag(nodes: ReadonlyArray<DecomposedNode>): void {
  const keys = new Set(nodes.map((n) => n.nodeKey));
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!keys.has(dep)) {
        throw new OrchestrationDagInvalidError(
          `Node ${n.nodeKey} depends on unknown node ${dep}`,
        );
      }
    }
  }
  // Cycle detection — Kahn's algorithm.
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.nodeKey, 0);
    adj.set(n.nodeKey, []);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      indeg.set(n.nodeKey, (indeg.get(n.nodeKey) ?? 0) + 1);
      adj.get(dep)!.push(n.nodeKey);
    }
  }
  const ready: string[] = [];
  for (const [k, v] of indeg) if (v === 0) ready.push(k);
  let visited = 0;
  while (ready.length > 0) {
    const k = ready.shift()!;
    visited += 1;
    for (const next of adj.get(k) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) ready.push(next);
    }
  }
  if (visited !== nodes.length) {
    throw new OrchestrationDagInvalidError(
      "Decomposed DAG contains a cycle",
    );
  }
}

// ─── Persistence helpers ────────────────────────────────────────────────────

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toOrchestrationRow(
  r: typeof agentOrchestrations.$inferSelect,
): OrchestrationRow {
  return {
    id: r.id,
    parentOrchestrationId: r.parentOrchestrationId,
    conversationId: r.conversationId,
    goal: r.goal,
    status: r.status as OrchestrationStatus,
    depth: r.depth,
    nodeCount: r.nodeCount,
    completedCount: r.completedCount,
    failedCount: r.failedCount,
    skippedCount: r.skippedCount,
    plan: r.plan,
    summary: r.summary,
    error: r.error,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toNodeRow(
  r: typeof orchestrationNodes.$inferSelect,
): OrchestrationNodeRow {
  return {
    id: r.id,
    orchestrationId: r.orchestrationId,
    nodeKey: r.nodeKey,
    agentType: r.agentType as AgentType,
    title: r.title,
    description: r.description,
    dependsOn: parseJson<string[]>(r.dependsOn) ?? [],
    input: parseJson<Record<string, unknown>>(r.input),
    output: parseJson<Record<string, unknown>>(r.output),
    status: r.status as NodeStatus,
    riskLevel: r.riskLevel as RiskLevel,
    requiresApproval: r.requiresApproval === 1,
    approvalDecision:
      r.approvalDecision === "approved" || r.approvalDecision === "denied"
        ? r.approvalDecision
        : null,
    attempts: r.attempts,
    error: r.error,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// ─── In-process tracking ────────────────────────────────────────────────────

// tier-review: bounded — one entry per actively-draining orchestration; removed in finally
const activeRuns = new Set<string>();

function parallelBudget(): number {
  try {
    const profile = getHardwareProfile();
    return profile.tier === "low" ? PARALLEL_BUDGET_LOW : PARALLEL_BUDGET_HIGH;
  } catch {
    return PARALLEL_BUDGET_LOW;
  }
}

// ─── Public CRUD API ────────────────────────────────────────────────────────

export async function createOrchestration(
  ctx: TenantContext,
  input: CreateOrchestrationInput,
): Promise<OrchestrationRow> {
  let depth = input.depth ?? 0;
  if (input.parentOrchestrationId) {
    const parent = await getOrchestrationRowInternal(
      ctx,
      input.parentOrchestrationId,
    );
    if (parent) depth = parent.depth + 1;
  }
  if (depth > MAX_ORCHESTRATION_DEPTH) {
    throw new OrchestrationDepthExceededError(depth);
  }

  const plan = decomposeGoal(input.goal);
  const id = `orc_${nanoid()}`;
  const planText = plan.nodes
    .map(
      (n, i) =>
        `${i + 1}. [${n.agentType}] ${n.title}` +
        (n.dependsOn.length > 0 ? ` (depends on: ${n.dependsOn.join(", ")})` : ""),
    )
    .join("\n");

  await db.insert(agentOrchestrations).values(
    withTenantValues(ctx, {
      id,
      parentOrchestrationId: input.parentOrchestrationId ?? null,
      conversationId: input.conversationId ?? null,
      goal: input.goal,
      status: "pending",
      depth,
      nodeCount: plan.nodes.length,
      plan: planText,
    }),
  );

  for (const n of plan.nodes) {
    await db.insert(orchestrationNodes).values(
      withTenantValues(ctx, {
        id: `orn_${nanoid()}`,
        orchestrationId: id,
        nodeKey: n.nodeKey,
        agentType: n.agentType,
        title: n.title,
        description: n.description,
        dependsOn: JSON.stringify(n.dependsOn),
        input: JSON.stringify(n.input),
        status: "pending",
        riskLevel: n.riskLevel,
        requiresApproval: n.requiresApproval ? 1 : 0,
      }),
    );
  }

  scheduleRun(ctx, id);
  const row = await getOrchestrationRowInternal(ctx, id);
  if (!row) throw new Error("Orchestration vanished after insert");
  return row;
}

async function getOrchestrationRowInternal(
  ctx: TenantContext,
  id: string,
): Promise<OrchestrationRow | null> {
  const rows = await db
    .select()
    .from(agentOrchestrations)
    .where(
      and(
        tenantScope(ctx, agentOrchestrations),
        eq(agentOrchestrations.id, id),
      ),
    )
    .limit(1);
  return rows[0] ? toOrchestrationRow(rows[0]) : null;
}

export async function getOrchestration(
  ctx: TenantContext,
  id: string,
): Promise<OrchestrationDetail | null> {
  const row = await getOrchestrationRowInternal(ctx, id);
  if (!row) return null;
  const nodes = await listOrchestrationNodes(ctx, id);
  return { ...row, nodes };
}

export async function listOrchestrations(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<OrchestrationRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, agentOrchestrations)];
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(agentOrchestrations.createdAt, cursorTs));
  }
  const rows = await db
    .select()
    .from(agentOrchestrations)
    .where(and(...conditions))
    .orderBy(desc(agentOrchestrations.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toOrchestrationRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function listOrchestrationNodes(
  ctx: TenantContext,
  orchestrationId: string,
): Promise<ReadonlyArray<OrchestrationNodeRow>> {
  const rows = await db
    .select()
    .from(orchestrationNodes)
    .where(
      and(
        tenantScope(ctx, orchestrationNodes),
        eq(orchestrationNodes.orchestrationId, orchestrationId),
      ),
    )
    .orderBy(asc(orchestrationNodes.createdAt));
  return rows.map(toNodeRow);
}

export async function cancelOrchestration(
  ctx: TenantContext,
  id: string,
): Promise<OrchestrationRow | null> {
  const existing = await getOrchestrationRowInternal(ctx, id);
  if (!existing) return null;
  if (
    existing.status === "completed" ||
    existing.status === "failed" ||
    existing.status === "cancelled"
  ) {
    return existing;
  }
  const now = Date.now();
  await db
    .update(agentOrchestrations)
    .set({ status: "cancelled", completedAt: now, updatedAt: now })
    .where(
      and(
        tenantScope(ctx, agentOrchestrations),
        eq(agentOrchestrations.id, id),
      ),
    );
  // Skip every still-pending / ready / awaiting node so the timeline
  // shows what happened.
  await db
    .update(orchestrationNodes)
    .set({ status: "skipped", completedAt: now, updatedAt: now })
    .where(
      and(
        tenantScope(ctx, orchestrationNodes),
        eq(orchestrationNodes.orchestrationId, id),
      ),
    );
  activeRuns.delete(id);
  return getOrchestrationRowInternal(ctx, id);
}

export interface ApprovalDecisionInput {
  decision: "approved" | "denied";
}

export async function decideOrchestrationApproval(
  ctx: TenantContext,
  orchestrationId: string,
  nodeKey: string,
  decision: ApprovalDecisionInput,
): Promise<OrchestrationNodeRow | null> {
  const rows = await db
    .select()
    .from(orchestrationNodes)
    .where(
      and(
        tenantScope(ctx, orchestrationNodes),
        eq(orchestrationNodes.orchestrationId, orchestrationId),
        eq(orchestrationNodes.nodeKey, nodeKey),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "awaiting_approval") return toNodeRow(row);
  const now = Date.now();
  await db
    .update(orchestrationNodes)
    .set({
      approvalDecision: decision.decision,
      // When approved, drop back to ready so the executor can pick it up
      // again. When denied, mark failed and let the failure-policy code
      // skip dependents on the next tick.
      status: decision.decision === "approved" ? "ready" : "failed",
      error: decision.decision === "denied" ? "Approval denied by user" : null,
      updatedAt: now,
    })
    .where(
      and(
        tenantScope(ctx, orchestrationNodes),
        eq(orchestrationNodes.id, row.id),
      ),
    );
  // Re-flip the orchestration to running so the timeline doesn't lie
  // about its state until the next tick lands.
  await db
    .update(agentOrchestrations)
    .set({ status: "running", updatedAt: now })
    .where(
      and(
        tenantScope(ctx, agentOrchestrations),
        eq(agentOrchestrations.id, orchestrationId),
      ),
    );
  scheduleRun(ctx, orchestrationId);
  const updated = await db
    .select()
    .from(orchestrationNodes)
    .where(
      and(
        tenantScope(ctx, orchestrationNodes),
        eq(orchestrationNodes.id, row.id),
      ),
    )
    .limit(1);
  return updated[0] ? toNodeRow(updated[0]) : null;
}

export async function getOrchestrationTrace(
  ctx: TenantContext,
  id: string,
): Promise<OrchestrationTrace | null> {
  const detail = await getOrchestration(ctx, id);
  if (!detail) return null;
  const totalDurationMs =
    detail.startedAt && detail.completedAt
      ? new Date(detail.completedAt).getTime() -
        new Date(detail.startedAt).getTime()
      : null;
  const entries: OrchestrationTraceEntry[] = detail.nodes.map((n) => ({
    nodeKey: n.nodeKey,
    agentType: n.agentType,
    title: n.title,
    status: n.status,
    riskLevel: n.riskLevel,
    attempts: n.attempts,
    durationMs:
      n.startedAt && n.completedAt
        ? new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()
        : null,
    dependsOn: n.dependsOn,
    input: n.input,
    output: n.output,
    error: n.error,
  }));
  return {
    orchestrationId: detail.id,
    goal: detail.goal,
    status: detail.status,
    totalDurationMs,
    nodes: entries,
  };
}

// ─── Executor ───────────────────────────────────────────────────────────────

function scheduleRun(ctx: TenantContext, orchestrationId: string): void {
  if (activeRuns.has(orchestrationId)) return;
  activeRuns.add(orchestrationId);
  setImmediate(() => {
    runDag(ctx, orchestrationId)
      .catch((e) => {
        logger.error(
          { err: e instanceof Error ? e.message : String(e), orchestrationId },
          "orchestrator: DAG run crashed",
        );
      })
      .finally(() => {
        activeRuns.delete(orchestrationId);
      });
  });
}

async function runDag(
  ctx: TenantContext,
  orchestrationId: string,
): Promise<void> {
  // Mark the orchestration as running on first tick.
  const orch = await getOrchestrationRowInternal(ctx, orchestrationId);
  if (!orch) return;
  if (orch.status === "cancelled") return;
  if (orch.status === "pending") {
    const now = Date.now();
    await db
      .update(agentOrchestrations)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(
        and(
          tenantScope(ctx, agentOrchestrations),
          eq(agentOrchestrations.id, orchestrationId),
        ),
      );
  }

  // Drain loop — pick ready nodes, run them in parallel up to budget.
  // eslint-disable-next-line no-constant-condition -- exited via terminal-state checks
  while (true) {
    const cur = await getOrchestrationRowInternal(ctx, orchestrationId);
    if (!cur) return;
    if (
      cur.status === "cancelled" ||
      cur.status === "completed" ||
      cur.status === "failed"
    ) {
      return;
    }

    const nodes = await listOrchestrationNodes(ctx, orchestrationId);

    // Short-circuit: an awaiting_approval node freezes the whole graph
    // until the route handler resolves it.
    const awaiting = nodes.find((n) => n.status === "awaiting_approval");
    if (awaiting) {
      await db
        .update(agentOrchestrations)
        .set({ status: "awaiting_approval", updatedAt: Date.now() })
        .where(
          and(
            tenantScope(ctx, agentOrchestrations),
            eq(agentOrchestrations.id, orchestrationId),
          ),
        );
      return;
    }

    // Failure-policy pass: if any node failed, skip all nodes that
    // transitively depend on it and decide whether the orchestration
    // can keep going.
    const failed = nodes.filter((n) => n.status === "failed");
    if (failed.length > 0) {
      const skipped = await skipDependentsOf(ctx, orchestrationId, failed, nodes);
      if (skipped > 0) {
        // Re-fetch and continue — the next loop iteration sees the new state.
        continue;
      }
    }

    const ready = nodes.filter(
      (n) =>
        (n.status === "pending" || n.status === "ready") &&
        n.dependsOn.every((dep) =>
          nodes.find((m) => m.nodeKey === dep && m.status === "completed"),
        ),
    );

    if (ready.length === 0) {
      // Nothing ready — either we're done, or every remaining node is
      // blocked on a failed dep (which the failure policy already skipped).
      const remaining = nodes.filter(
        (n) =>
          n.status === "pending" ||
          n.status === "ready" ||
          n.status === "running" ||
          n.status === "awaiting_approval",
      );
      if (remaining.length === 0) {
        await finalise(ctx, orchestrationId, nodes);
        return;
      }
      // Running nodes still in flight elsewhere — but the executor here
      // is the only writer, so nothing else will flip them. Treat as
      // stuck: finalise based on current state.
      await finalise(ctx, orchestrationId, nodes);
      return;
    }

    const budget = parallelBudget();
    const slice = ready.slice(0, budget);

    // Approval gate: any node that requires approval and has not been
    // approved yet flips to awaiting_approval BEFORE running.
    const gated: OrchestrationNodeRow[] = [];
    const runnable: OrchestrationNodeRow[] = [];
    for (const n of slice) {
      if (n.requiresApproval && n.approvalDecision !== "approved") {
        gated.push(n);
      } else {
        runnable.push(n);
      }
    }
    if (gated.length > 0) {
      const now = Date.now();
      for (const n of gated) {
        await db
          .update(orchestrationNodes)
          .set({ status: "awaiting_approval", updatedAt: now })
          .where(
            and(
              tenantScope(ctx, orchestrationNodes),
              eq(orchestrationNodes.id, n.id),
            ),
          );
      }
      // Loop back so the awaiting_approval branch above flips the orch.
      continue;
    }

    if (runnable.length === 0) continue;

    await Promise.all(
      runnable.map((n) => executeNode(ctx, orchestrationId, n.id)),
    );
  }
}

async function executeNode(
  ctx: TenantContext,
  orchestrationId: string,
  nodeId: string,
): Promise<void> {
  const now = Date.now();
  const claimed = await db
    .update(orchestrationNodes)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        tenantScope(ctx, orchestrationNodes),
        eq(orchestrationNodes.id, nodeId),
      ),
    )
    .returning();
  const row = claimed[0];
  if (!row) return;

  // Gather outputs from each dependency so the agent receives typed input.
  const allNodes = await listOrchestrationNodes(ctx, orchestrationId);
  const node = toNodeRow(row);
  const depOutputs: Record<string, Record<string, unknown> | null> = {};
  for (const dep of node.dependsOn) {
    const depRow = allNodes.find((n) => n.nodeKey === dep);
    depOutputs[dep] = depRow?.output ?? null;
  }

  const agentInput = {
    ...(node.input ?? {}),
    upstream: depOutputs,
  };

  try {
    const output = await runAgent(node.agentType, agentInput);
    const stamp = Date.now();
    await db
      .update(orchestrationNodes)
      .set({
        status: "completed",
        output: JSON.stringify(output),
        attempts: row.attempts + 1,
        completedAt: stamp,
        updatedAt: stamp,
      })
      .where(
        and(
          tenantScope(ctx, orchestrationNodes),
          eq(orchestrationNodes.id, nodeId),
        ),
      );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const attempts = row.attempts + 1;
    const stamp = Date.now();
    if (attempts < MAX_NODE_ATTEMPTS) {
      // Bounce back to ready for another shot.
      await db
        .update(orchestrationNodes)
        .set({
          status: "ready",
          attempts,
          error: errMsg,
          updatedAt: stamp,
        })
        .where(
          and(
            tenantScope(ctx, orchestrationNodes),
            eq(orchestrationNodes.id, nodeId),
          ),
        );
    } else {
      await db
        .update(orchestrationNodes)
        .set({
          status: "failed",
          attempts,
          error: errMsg,
          completedAt: stamp,
          updatedAt: stamp,
        })
        .where(
          and(
            tenantScope(ctx, orchestrationNodes),
            eq(orchestrationNodes.id, nodeId),
          ),
        );
    }
  }
  // Bump the orchestration counters.
  await refreshCounts(ctx, orchestrationId);
}

async function refreshCounts(
  ctx: TenantContext,
  orchestrationId: string,
): Promise<void> {
  const nodes = await listOrchestrationNodes(ctx, orchestrationId);
  const completed = nodes.filter((n) => n.status === "completed").length;
  const failed = nodes.filter((n) => n.status === "failed").length;
  const skipped = nodes.filter((n) => n.status === "skipped").length;
  await db
    .update(agentOrchestrations)
    .set({
      completedCount: completed,
      failedCount: failed,
      skippedCount: skipped,
      updatedAt: Date.now(),
    })
    .where(
      and(
        tenantScope(ctx, agentOrchestrations),
        eq(agentOrchestrations.id, orchestrationId),
      ),
    );
}

async function skipDependentsOf(
  ctx: TenantContext,
  orchestrationId: string,
  failedNodes: ReadonlyArray<OrchestrationNodeRow>,
  allNodes: ReadonlyArray<OrchestrationNodeRow>,
): Promise<number> {
  const failedKeys = new Set(failedNodes.map((n) => n.nodeKey));
  // Compute every node transitively reachable from a failed key.
  let dirty = true;
  while (dirty) {
    dirty = false;
    for (const n of allNodes) {
      if (failedKeys.has(n.nodeKey)) continue;
      if (n.dependsOn.some((d) => failedKeys.has(d))) {
        failedKeys.add(n.nodeKey);
        dirty = true;
      }
    }
  }
  const toSkip = allNodes.filter(
    (n) =>
      failedKeys.has(n.nodeKey) &&
      n.status !== "failed" &&
      n.status !== "skipped" &&
      n.status !== "completed",
  );
  if (toSkip.length === 0) return 0;
  const now = Date.now();
  for (const n of toSkip) {
    await db
      .update(orchestrationNodes)
      .set({
        status: "skipped",
        error: `Skipped: upstream node failed`,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          tenantScope(ctx, orchestrationNodes),
          eq(orchestrationNodes.id, n.id),
        ),
      );
  }
  await refreshCounts(ctx, orchestrationId);
  return toSkip.length;
}

async function finalise(
  ctx: TenantContext,
  orchestrationId: string,
  nodes: ReadonlyArray<OrchestrationNodeRow>,
): Promise<void> {
  const completed = nodes.filter((n) => n.status === "completed").length;
  const failed = nodes.filter((n) => n.status === "failed").length;
  const skipped = nodes.filter((n) => n.status === "skipped").length;
  // Critical-path detection: an orchestration only counts as "failed"
  // when at least one terminal (no-children) node ended in failed/skipped.
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      const list = childrenOf.get(d) ?? [];
      list.push(n.nodeKey);
      childrenOf.set(d, list);
    }
  }
  const terminals = nodes.filter(
    (n) => (childrenOf.get(n.nodeKey) ?? []).length === 0,
  );
  const allTerminalsOk = terminals.every((n) => n.status === "completed");
  const status: OrchestrationStatus = allTerminalsOk ? "completed" : "failed";
  const summary =
    status === "completed"
      ? `Completed ${completed}/${nodes.length} node(s) across ${terminals.length} terminal output(s).`
      : `Finished with ${failed} failed and ${skipped} skipped node(s); ${completed}/${nodes.length} succeeded.`;
  const error =
    status === "failed"
      ? nodes.find((n) => n.status === "failed")?.error ?? "Critical-path node failed"
      : null;
  const stamp = Date.now();
  await db
    .update(agentOrchestrations)
    .set({
      status,
      summary,
      error,
      completedCount: completed,
      failedCount: failed,
      skippedCount: skipped,
      completedAt: stamp,
      updatedAt: stamp,
    })
    .where(
      and(
        tenantScope(ctx, agentOrchestrations),
        eq(agentOrchestrations.id, orchestrationId),
      ),
    );
}

// ─── Specialised agent stubs ────────────────────────────────────────────────

/**
 * Tier-1 deterministic agent dispatch. Each agent returns a structured
 * payload keyed off `agentType` + the goal so downstream nodes always
 * see typed data, never raw text. Live model-backed implementations
 * will swap in here without changing the orchestrator.
 */
async function runAgent(
  agentType: AgentType,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const goal = String(input["goal"] ?? "");
  switch (agentType) {
    case "research":
      return {
        agent: "research",
        goal,
        sources: [
          { kind: "stub", title: `Source for ${goal}`, summary: "Tier-1 stub" },
        ],
        notes: `Research notes for: ${goal}`,
      };
    case "writing":
      return {
        agent: "writing",
        goal,
        document: {
          title: `Draft for: ${goal}`,
          sections: ["Summary", "Details", "Next steps"],
        },
      };
    case "code":
      return {
        agent: "code",
        goal,
        artifact: { language: "typescript", lineCount: 0 },
      };
    case "desktop":
      return {
        agent: "desktop",
        goal,
        actions: [{ kind: "noop", target: "stub", verified: true }],
      };
    case "data":
      return {
        agent: "data",
        goal,
        records: [],
        sourceCount: 0,
      };
    case "communication":
      return {
        agent: "communication",
        goal,
        delivered: true,
        channels: ["stub"],
      };
    default:
      throw new Error(`Unknown agent type: ${agentType as string}`);
  }
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * Wait for an orchestration to reach a terminal state (or
 * `awaiting_approval`). Used by the test runner so cases can assert on
 * post-execution state without polling the HTTP surface.
 */
export async function drainOrchestrationForTests(
  ctx: TenantContext,
  id: string,
  timeoutMs = 5000,
): Promise<OrchestrationRow | null> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition -- bounded by timeout
  while (true) {
    const row = await getOrchestrationRowInternal(ctx, id);
    if (!row) return null;
    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled" ||
      row.status === "awaiting_approval"
    ) {
      return row;
    }
    if (Date.now() - start > timeoutMs) return row;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function __resetOrchestratorForTests(): void {
  activeRuns.clear();
}
