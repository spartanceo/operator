/**
 * Desktop control orchestrator — Look → Act → Verify (LAV).
 *
 * One desktop session bundles a goal, a deterministic plan, and an ordered
 * list of steps. Each step is the unit of LAV: the vision adapter resolves
 * a SEMANTIC target (Look), the input adapter performs the action (Act),
 * and the vision adapter verifies the resulting state (Verify). Coordinates
 * never appear here — only descriptions like "the blue Save button".
 *
 * Risk gating: medium+ steps spawn an `approvals` row that the user must
 * decide on before the orchestrator advances. The frontend surfaces these
 * as Step Approval Cards in the live panel.
 *
 * Routes are thin — they validate input, call into this module, and return
 * the canonical envelopes. Every public function honours `tenantScope` so
 * cross-tenant lookups are impossible.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  agentRuns as agentRunsTable,
  approvals as approvalsTable,
  buildPage,
  db,
  decodeCursor,
  desktopSessions,
  desktopSteps,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  toolCalls as toolCallsTable,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import {
  acknowledgeThrottle,
  getThrottle,
  setPhase as setDrgPhase,
  tickMemoryMonitor,
} from "./drg.service";
import { logPrivacyEvent } from "./privacy.service";
import {
  captureScreenshot,
  clickTarget,
  type DesktopActionReceipt,
  type DesktopAdapterStatus,
  type DesktopScreenshotPayload,
  dragDrop,
  openApplication,
  pressKey,
  probeAdapter,
  readScreenText,
  resolveTarget,
  runTerminalCommand,
  scroll as scrollAdapter,
  typeText,
} from "./desktop-input.service";
import {
  planSteps,
  verifyStep,
  type VisionPlanStep,
} from "./desktop-vision.service";

// ─── Public types ───────────────────────────────────────────────────────────

export interface DesktopSessionRow {
  id: string;
  runId: string | null;
  goal: string;
  status: string;
  mode: string;
  plan: string | null;
  summary: string | null;
  error: string | null;
  modelName: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopStepRow {
  id: string;
  sessionId: string;
  stepIndex: number;
  actionType: string;
  targetDescription: string;
  targetRole: string | null;
  targetLabel: string | null;
  inputValue: string | null;
  riskLevel: string;
  needsApproval: boolean;
  status: string;
  expectedState: string | null;
  observedState: string | null;
  verifyAttempts: number;
  toolCallId: string | null;
  approvalId: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDesktopSessionInput {
  goal: string;
  modelName?: string;
  autoExecute?: boolean;
}

export interface DesktopFeatureStatus extends DesktopAdapterStatus {
  enabled: boolean;
}

// Status values in one place so tests + frontend share the canonical
// set without inventing strings.
export const SESSION_STATUS = {
  planning: "planning",
  awaitingApproval: "awaiting_approval",
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
} as const;

export const STEP_STATUS = {
  pending: "pending",
  awaitingApproval: "awaiting_approval",
  running: "running",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
} as const;

// tier-review: bounded — fixed 3-element status enum, never mutated.
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.completed,
  SESSION_STATUS.failed,
  SESSION_STATUS.stopped,
]);

// ─── Mappers ────────────────────────────────────────────────────────────────

function toSessionRow(r: typeof desktopSessions.$inferSelect): DesktopSessionRow {
  return {
    id: r.id,
    runId: r.runId,
    goal: r.goal,
    status: r.status,
    mode: r.mode,
    plan: r.planJson,
    summary: r.summary,
    error: r.error,
    modelName: r.modelName,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    stoppedAt: r.stoppedAt ? new Date(r.stoppedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toStepRow(r: typeof desktopSteps.$inferSelect): DesktopStepRow {
  return {
    id: r.id,
    sessionId: r.sessionId,
    stepIndex: r.stepIndex,
    actionType: r.actionType,
    targetDescription: r.targetDescription,
    targetRole: r.targetRole,
    targetLabel: r.targetLabel,
    inputValue: r.inputValue,
    riskLevel: r.riskLevel,
    needsApproval: Boolean(r.needsApproval),
    status: r.status,
    expectedState: r.expectedState,
    observedState: r.observedState,
    verifyAttempts: r.verifyAttempts,
    toolCallId: r.toolCallId,
    approvalId: r.approvalId,
    error: r.error,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// ─── Feature flag ───────────────────────────────────────────────────────────

/**
 * Standard 9 feature flag. Default OFF — opt-in via env. We expose this so
 * the frontend can degrade gracefully (read-only history list + disabled
 * "Start session" button) when desktop control isn't enabled.
 */
export function getFeatureStatus(): DesktopFeatureStatus {
  const adapter = probeAdapter();
  const flag = process.env["FEATURE_DESKTOP_CONTROL"];
  const enabled = flag === "1" || flag === "true";
  if (!enabled) {
    return {
      ...adapter,
      enabled: false,
      reason:
        "Desktop control is disabled. Set FEATURE_DESKTOP_CONTROL=1 to enable. " +
        adapter.reason,
    };
  }
  return { ...adapter, enabled: true };
}

// ─── Sessions: list / get / create / stop ───────────────────────────────────

export async function listSessions(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<DesktopSessionRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, desktopSessions);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(desktopSessions.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(desktopSessions)
    .where(where)
    .orderBy(desc(desktopSessions.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toSessionRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getSession(
  ctx: TenantContext,
  id: string,
): Promise<DesktopSessionRow | null> {
  const rows = await db
    .select()
    .from(desktopSessions)
    .where(and(tenantScope(ctx, desktopSessions), eq(desktopSessions.id, id)))
    .limit(1);
  return rows[0] ? toSessionRow(rows[0]) : null;
}

export async function getStep(
  ctx: TenantContext,
  id: string,
): Promise<DesktopStepRow | null> {
  const rows = await db
    .select()
    .from(desktopSteps)
    .where(and(tenantScope(ctx, desktopSteps), eq(desktopSteps.id, id)))
    .limit(1);
  return rows[0] ? toStepRow(rows[0]) : null;
}

export async function listSteps(
  ctx: TenantContext,
  sessionId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<DesktopStepRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorIdx = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = and(
    tenantScope(ctx, desktopSteps),
    eq(desktopSteps.sessionId, sessionId),
  );
  const where =
    cursorIdx !== null && Number.isFinite(cursorIdx)
      ? and(baseScope, lt(desktopSteps.stepIndex, cursorIdx))
      : baseScope;
  const rows = await db
    .select()
    .from(desktopSteps)
    .where(where)
    .orderBy(desc(desktopSteps.stepIndex))
    .limit(limit + 1);
  // Steps render top-to-bottom by stepIndex ascending in the UI; we sort
  // descending here for cursor stability and let the frontend reorder.
  return buildPage(rows.map(toStepRow), limit, (r) => String(r.stepIndex));
}

export async function createSession(
  ctx: TenantContext,
  input: CreateDesktopSessionInput,
): Promise<DesktopSessionRow> {
  const status = getFeatureStatus();
  const id = `dsk_${nanoid()}`;
  const now = Date.now();

  // Plan first so we can stash the JSON snapshot on the row.
  const plan = await planSteps(ctx, input.goal);

  await db.insert(desktopSessions).values(
    withTenantValues(ctx, {
      id,
      goal: input.goal,
      status: status.enabled ? SESSION_STATUS.planning : SESSION_STATUS.failed,
      mode: "sequential",
      planJson: JSON.stringify(plan),
      modelName: input.modelName ?? null,
      startedAt: now,
      ...(status.enabled
        ? {}
        : { error: status.reason, completedAt: now }),
    }),
  );

  // Persist each step row so the audit + UI have something to render.
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    const needsApproval = step.riskLevel !== "low";
    await db.insert(desktopSteps).values(
      withTenantValues(ctx, {
        id: `dst_${nanoid()}`,
        sessionId: id,
        stepIndex: i,
        actionType: step.actionType,
        targetDescription: step.targetDescription,
        targetRole: step.targetRole ?? null,
        targetLabel: step.targetLabel ?? null,
        inputValue: step.inputValue ?? null,
        riskLevel: step.riskLevel,
        needsApproval: needsApproval ? 1 : 0,
        status: needsApproval
          ? STEP_STATUS.awaitingApproval
          : STEP_STATUS.pending,
        expectedState: step.expectedState,
      }),
    );
  }

  await logPrivacyEvent(ctx, {
    eventType: "desktop.session.created",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "medium",
    detail: `goal=${input.goal.slice(0, 120)} steps=${plan.length} feature=${
      status.enabled ? "on" : "off"
    }`,
  });

  // Auto-execute path: walk every step that is not gated. Gated steps stay
  // on `awaiting_approval` until the user decides via the route.
  if (status.enabled && input.autoExecute !== false) {
    await advanceSession(ctx, id);
  }

  const final = await getSession(ctx, id);
  if (!final) throw new Error("Desktop session vanished after creation");
  return final;
}

export async function stopSession(
  ctx: TenantContext,
  id: string,
): Promise<DesktopSessionRow | null> {
  const existing = await getSession(ctx, id);
  if (!existing) return null;
  if (TERMINAL_SESSION_STATUSES.has(existing.status)) {
    return existing;
  }
  const now = Date.now();
  await db
    .update(desktopSessions)
    .set({
      status: SESSION_STATUS.stopped,
      stoppedAt: now,
      completedAt: now,
      updatedAt: now,
      summary:
        (existing.summary ? `${existing.summary}\n` : "") +
        "Session halted by user.",
    })
    .where(and(tenantScope(ctx, desktopSessions), eq(desktopSessions.id, id)));

  // Cancel any in-flight pending steps so the timeline reflects the stop.
  await db
    .update(desktopSteps)
    .set({ status: STEP_STATUS.skipped, updatedAt: now })
    .where(
      and(
        tenantScope(ctx, desktopSteps),
        eq(desktopSteps.sessionId, id),
        eq(desktopSteps.status, STEP_STATUS.pending),
      ),
    );

  await logPrivacyEvent(ctx, {
    eventType: "desktop.session.stopped",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "high",
    detail: "user-initiated",
  });

  return getSession(ctx, id);
}

/** Get the latest screen frame for the live panel. Tier 1: stub frame. */
export async function getLatestScreen(
  ctx: TenantContext,
  sessionId: string,
): Promise<DesktopScreenshotPayload & { sessionId: string }> {
  const session = await getSession(ctx, sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  const payload = await captureScreenshot(ctx);
  return { ...payload, sessionId };
}

// ─── Step execution: the LAV cycle ───────────────────────────────────────────

export async function executeStep(
  ctx: TenantContext,
  stepId: string,
): Promise<DesktopStepRow | null> {
  const step = await getStep(ctx, stepId);
  if (!step) return null;
  const session = await getSession(ctx, step.sessionId);
  if (!session) return null;

  if (TERMINAL_SESSION_STATUSES.has(session.status)) {
    return step;
  }

  if (
    step.needsApproval &&
    !(await isApproved(ctx, step.approvalId))
  ) {
    return await ensureAwaitingApproval(ctx, step);
  }

  // Already executed → idempotent return.
  if (
    step.status === STEP_STATUS.completed ||
    step.status === STEP_STATUS.failed
  ) {
    return step;
  }

  return await runStep(ctx, step);
}

async function isApproved(
  ctx: TenantContext,
  approvalId: string | null,
): Promise<boolean> {
  if (!approvalId) return false;
  const rows = await db
    .select()
    .from(approvalsTable)
    .where(
      and(tenantScope(ctx, approvalsTable), eq(approvalsTable.id, approvalId)),
    )
    .limit(1);
  return rows[0]?.decision === "approved";
}

async function ensureAwaitingApproval(
  ctx: TenantContext,
  step: DesktopStepRow,
): Promise<DesktopStepRow> {
  if (step.approvalId) {
    // Already has a gate row — just refresh state and return.
    const updated = await getStep(ctx, step.id);
    return updated ?? step;
  }

  // The approvals table joins to a tool_calls row, so we synthesise a
  // tool_call row marked `awaiting_approval` to satisfy the FK without
  // executing anything yet.
  const toolCallId = `tc_${nanoid()}`;
  const approvalId = `apr_${nanoid()}`;
  const now = Date.now();
  // Approvals + tool_calls both FK to agent_runs.id. Desktop sessions are
  // a separate timeline, so we mint a placeholder agent_run row keyed by
  // the desktop session id so the FK + listAgentRunApprovals scope still
  // line up. Idempotent: only inserted on first encounter.
  const session = await getSession(ctx, step.sessionId);
  const existingRun = await db
    .select({ id: agentRunsTable.id })
    .from(agentRunsTable)
    .where(
      and(tenantScope(ctx, agentRunsTable), eq(agentRunsTable.id, step.sessionId)),
    )
    .limit(1);
  if (existingRun.length === 0) {
    await db.insert(agentRunsTable).values(
      withTenantValues(ctx, {
        id: step.sessionId,
        goal: session?.goal ?? `Desktop session ${step.sessionId}`,
        status: "running",
        plan: "Desktop control session — see /api/desktop/sessions for steps.",
        startedAt: now,
      }),
    );
  }
  // Approvals require a runId on the joined row; desktop sessions are not
  // necessarily linked to an agent run, so we mint a synthetic placeholder
  // tool-call shape that points at the session id namespace.
  await db.insert(toolCallsTable).values(
    withTenantValues(ctx, {
      id: toolCallId,
      runId: step.sessionId, // session id reused as the run dimension here
      toolName: `desktop.${step.actionType}`,
      riskLevel: step.riskLevel,
      status: "awaiting_approval",
      input: JSON.stringify({
        target: step.targetDescription,
        inputValue: step.inputValue,
      }),
      startedAt: now,
    }),
  );
  await db.insert(approvalsTable).values(
    withTenantValues(ctx, {
      id: approvalId,
      runId: step.sessionId,
      toolCallId,
      reason: `Desktop step ${step.stepIndex + 1} (${step.actionType}) is ${step.riskLevel} risk.`,
      summary: `${step.actionType}: ${step.targetDescription}`,
      decision: "pending",
    }),
  );
  await db
    .update(desktopSteps)
    .set({
      status: STEP_STATUS.awaitingApproval,
      toolCallId,
      approvalId,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, desktopSteps), eq(desktopSteps.id, step.id)));

  await db
    .update(desktopSessions)
    .set({ status: SESSION_STATUS.awaitingApproval, updatedAt: now })
    .where(
      and(
        tenantScope(ctx, desktopSessions),
        eq(desktopSessions.id, step.sessionId),
      ),
    );

  const refreshed = await getStep(ctx, step.id);
  return refreshed ?? step;
}

/**
 * LAV self-healing — verify failures retry up to MAX_VERIFY_ATTEMPTS
 * times before escalating. Per Task #36 spec:
 *   Attempt 1: re-index (re-run the act + verify cycle)
 *   Attempt 2: alternative approach (logged on the row)
 *   Attempt 3: escalate to user — step parks with a needs-guidance error
 */
const MAX_VERIFY_ATTEMPTS = 3;

async function runStep(
  ctx: TenantContext,
  step: DesktopStepRow,
): Promise<DesktopStepRow> {
  // DRG memory-pressure gate — pause before doing anything if a throttle
  // event is pending (or one fires on this tick).
  tickMemoryMonitor();
  const pending = getThrottle();
  if (pending) {
    const reason = pending.reason;
    acknowledgeThrottle();
    const errMsg = `DRG throttle: ${reason}`;
    const completedAt = Date.now();
    await db
      .update(desktopSteps)
      .set({
        status: STEP_STATUS.failed,
        error: errMsg,
        completedAt,
        updatedAt: completedAt,
      })
      .where(and(tenantScope(ctx, desktopSteps), eq(desktopSteps.id, step.id)));
    await markSessionFailed(ctx, step.sessionId, errMsg);
    const refreshed = await getStep(ctx, step.id);
    return refreshed ?? step;
  }

  const startedAt = Date.now();
  await db
    .update(desktopSteps)
    .set({
      status: STEP_STATUS.running,
      startedAt,
      updatedAt: startedAt,
    })
    .where(and(tenantScope(ctx, desktopSteps), eq(desktopSteps.id, step.id)));
  await db
    .update(desktopSessions)
    .set({ status: SESSION_STATUS.running, updatedAt: startedAt })
    .where(
      and(
        tenantScope(ctx, desktopSessions),
        eq(desktopSessions.id, step.sessionId),
      ),
    );

  setDrgPhase("looking", { sessionId: step.sessionId });

  let actReceipt: DesktopActionReceipt | null = null;
  let lastObserved = "";
  let attempts = step.verifyAttempts;
  let matched = false;

  for (let i = 0; i < MAX_VERIFY_ATTEMPTS && !matched; i++) {
    setDrgPhase("acting", { sessionId: step.sessionId });
    try {
      actReceipt = await dispatchAction(ctx, step);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error({ err: e, stepId: step.id }, "Desktop step failed");
      const completedAt = Date.now();
      await db
        .update(desktopSteps)
        .set({
          status: STEP_STATUS.failed,
          error: errMsg,
          completedAt,
          updatedAt: completedAt,
        })
        .where(and(tenantScope(ctx, desktopSteps), eq(desktopSteps.id, step.id)));
      await markSessionFailed(ctx, step.sessionId, errMsg);
      const refreshed = await getStep(ctx, step.id);
      return refreshed ?? step;
    }

    setDrgPhase("verifying", { sessionId: step.sessionId });
    const verdict = await verifyStep(
      ctx,
      step.expectedState ?? "no expectation set",
    );
    attempts += 1;
    lastObserved = verdict.observed;
    matched = verdict.matched;

    if (!matched && i + 1 < MAX_VERIFY_ATTEMPTS) {
      // Tier strategy: log the recovery move so the audit trail is honest.
      const strategy = i === 0 ? "reindex" : "alternative-approach";
      await logPrivacyEvent(ctx, {
        eventType: "desktop.lav.recover",
        actor: ctx.userId ?? ctx.tenantId,
        target: step.id,
        severity: "low",
        detail: `attempt=${attempts} strategy=${strategy} observed=${verdict.observed.slice(0, 160)}`,
      });
    }
  }

  setDrgPhase("idle", { sessionId: step.sessionId });

  const completedAt = Date.now();
  const escalated = !matched;
  const finalStatus = matched
    ? STEP_STATUS.completed
    : STEP_STATUS.awaitingApproval; // park for user guidance
  const errorText = escalated
    ? `Verification failed after ${attempts} attempts. Last observed: ${lastObserved}`
    : null;
  await db
    .update(desktopSteps)
    .set({
      status: finalStatus,
      observedState: actReceipt?.observedState ?? lastObserved,
      verifyAttempts: attempts,
      completedAt,
      updatedAt: completedAt,
      ...(escalated ? { error: errorText } : {}),
    })
    .where(and(tenantScope(ctx, desktopSteps), eq(desktopSteps.id, step.id)));

  if (escalated) {
    await logPrivacyEvent(ctx, {
      eventType: "desktop.lav.escalated",
      actor: ctx.userId ?? ctx.tenantId,
      target: step.id,
      severity: "medium",
      detail: errorText ?? "lav-escalation",
    });
    await db
      .update(desktopSessions)
      .set({
        status: SESSION_STATUS.awaitingApproval,
        updatedAt: completedAt,
      })
      .where(
        and(
          tenantScope(ctx, desktopSessions),
          eq(desktopSessions.id, step.sessionId),
        ),
      );
    const refreshed = await getStep(ctx, step.id);
    return refreshed ?? step;
  }

  await advanceSession(ctx, step.sessionId);

  const refreshed = await getStep(ctx, step.id);
  return refreshed ?? step;
}

async function dispatchAction(
  ctx: TenantContext,
  step: DesktopStepRow,
): Promise<DesktopActionReceipt> {
  const target = {
    description: step.targetDescription,
    role: step.targetRole ?? undefined,
    label: step.targetLabel ?? undefined,
  };
  switch (step.actionType) {
    case "screenshot": {
      const frame = await captureScreenshot(ctx);
      return {
        source: frame.source,
        action: "screenshot",
        description: "screen",
        ok: true,
        observedState: `frame ${frame.width}×${frame.height}`,
      };
    }
    case "find_element":
      return resolveTarget(ctx, target);
    case "click":
      return clickTarget(ctx, target);
    case "type_text":
      return typeText(ctx, step.inputValue ?? "");
    case "press_key":
      return pressKey(ctx, step.inputValue ?? "Enter");
    case "open_application":
      return openApplication(ctx, step.targetDescription);
    case "scroll":
      return scrollAdapter(
        ctx,
        (step.inputValue as "up" | "down" | "left" | "right") ?? "down",
        Number.parseInt(step.targetLabel ?? "3", 10) || 3,
      );
    case "drag_drop":
      return dragDrop(ctx, target, target);
    case "read_text":
      return readScreenText(ctx, step.targetDescription);
    case "terminal":
      return runTerminalCommand(ctx, step.inputValue ?? "");
    default:
      return {
        source: "stub",
        action: step.actionType,
        description: step.targetDescription,
        ok: false,
        detail: `Unknown action type: ${step.actionType}`,
      };
  }
}

async function advanceSession(
  ctx: TenantContext,
  sessionId: string,
): Promise<void> {
  // Walk every step in order — when we hit one that needs approval (and
  // doesn't already have one), park there. When we hit a pending non-gated
  // step, run it. Stop when there's nothing left to do.
  for (;;) {
    const all = await db
      .select()
      .from(desktopSteps)
      .where(
        and(
          tenantScope(ctx, desktopSteps),
          eq(desktopSteps.sessionId, sessionId),
        ),
      )
      .orderBy(desktopSteps.stepIndex);
    const next = all
      .map(toStepRow)
      .find((s) =>
        s.status === STEP_STATUS.pending ||
        s.status === STEP_STATUS.awaitingApproval,
      );
    if (!next) {
      await markSessionCompleted(ctx, sessionId, all.map(toStepRow));
      return;
    }
    if (
      next.status === STEP_STATUS.awaitingApproval ||
      next.needsApproval
    ) {
      // Mint the approval row on first encounter — steps inserted by
      // createSession arrive with status=awaiting_approval but no
      // approvalId yet, and the user can't decide on a row that
      // doesn't exist.
      await ensureAwaitingApproval(ctx, next);
      // Park — user must call /desktop/steps/{id}/execute after deciding.
      await db
        .update(desktopSessions)
        .set({
          status: SESSION_STATUS.awaitingApproval,
          updatedAt: Date.now(),
        })
        .where(
          and(
            tenantScope(ctx, desktopSessions),
            eq(desktopSessions.id, sessionId),
          ),
        );
      return;
    }
    const result = await runStep(ctx, next);
    if (result.status === STEP_STATUS.failed) return;
  }
}

async function markSessionCompleted(
  ctx: TenantContext,
  sessionId: string,
  steps: DesktopStepRow[],
): Promise<void> {
  const failed = steps.filter((s) => s.status === STEP_STATUS.failed).length;
  const completed = steps.filter((s) => s.status === STEP_STATUS.completed).length;
  const completedAt = Date.now();
  const status = failed > 0 ? SESSION_STATUS.failed : SESSION_STATUS.completed;
  const summary = `${completed}/${steps.length} step(s) completed; ${failed} failed.`;
  await db
    .update(desktopSessions)
    .set({ status, completedAt, updatedAt: completedAt, summary })
    .where(
      and(tenantScope(ctx, desktopSessions), eq(desktopSessions.id, sessionId)),
    );
  await logPrivacyEvent(ctx, {
    eventType: "desktop.session.completed",
    actor: ctx.userId ?? ctx.tenantId,
    target: sessionId,
    severity: "medium",
    detail: summary,
  });
}

async function markSessionFailed(
  ctx: TenantContext,
  sessionId: string,
  error: string,
): Promise<void> {
  const completedAt = Date.now();
  await db
    .update(desktopSessions)
    .set({
      status: SESSION_STATUS.failed,
      error,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(tenantScope(ctx, desktopSessions), eq(desktopSessions.id, sessionId)),
    );
}

export class SessionNotFoundError extends Error {
  override readonly name = "SessionNotFoundError";
  readonly code = "DESKTOP_SESSION_NOT_FOUND";
  constructor(id: string) {
    super(`Desktop session ${id} not found`);
  }
}
