/**
 * Skill Moderation Pipeline orchestrator (Task #57).
 *
 * End-to-end flow for a skill submission:
 *
 *   1. Create a `skill_moderation_submissions` row with the source +
 *      manifest the creator supplied. Status: `pending`.
 *   2. Run static analysis (synchronous, < 60s SLA).
 *      - If any critical/high finding → status `rejected` automatically,
 *        creator gets a detailed report.
 *   3. Run dynamic analysis (synchronous against the in-process VM
 *      sandbox; in production the same shape runs against a Docker
 *      container — see `skill-dynamic-analysis.service.ts` header).
 *      - If any critical/high violation → status `rejected`.
 *   4. Score-route: low risk + verified creator → auto-approve. Higher
 *      risk → `awaiting_review` with the appropriate priority queue.
 *
 * Reviewer actions: approve, reject (with feedback), escalate to senior,
 * emergency-suspend a published skill.
 *
 * Creator actions: appeal a rejection within 14 days; three rejections
 * for the same slug without addressing feedback triggers a 30-day ban.
 *
 * Post-publish monitoring helpers: `rescanForVulnerabilities` walks
 * every published skill against the dependency database, suspends
 * anything newly affected, and writes a `skill_moderation_rescans`
 * audit row.
 */
import { and, desc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  skillModerationAppeals,
  skillModerationRescans,
  skillModerationSubmissions,
  storeSkills,
  SYSTEM_TENANT_ID,
  SYSTEM_WORKSPACE_ID,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";
import {
  auditDependencies,
  runStaticAnalysis,
  type SkillManifestInput,
  type StaticAnalysisReport,
} from "./skill-static-analysis.service";
import {
  runDynamicAnalysis,
  type DynamicAnalysisReport,
} from "./skill-dynamic-analysis.service";

const SYSTEM_CONTEXT: TenantContext = {
  tenantId: SYSTEM_TENANT_ID,
  workspaceId: SYSTEM_WORKSPACE_ID,
  requestId: "skill-moderation",
};

const STANDARD_SLA_MS = 48 * 60 * 60 * 1000;
const VERIFIED_SLA_MS = 24 * 60 * 60 * 1000;
const APPEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const SUBMISSION_BAN_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_APPROVE_RISK_LIMIT = 15;
const AUTO_REJECT_RISK_LIMIT = 75;

export class ModerationError extends Error {
  override readonly name = "ModerationError";
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type ModerationStatus =
  | "pending"
  | "static_running"
  | "static_failed"
  | "dynamic_running"
  | "dynamic_failed"
  | "awaiting_review"
  | "approved"
  | "rejected"
  | "suspended";

export type AutoDecision =
  | ""
  | "auto_approved"
  | "auto_rejected"
  | "queued_for_review";

export type SubmissionPriority = "standard" | "verified";

export interface SubmissionInput {
  readonly source: string;
  readonly manifest: SkillManifestInput;
  readonly draftId?: string;
  readonly creatorId?: string;
  readonly creatorHandle?: string;
  readonly slug?: string;
  readonly name?: string;
  readonly priority?: SubmissionPriority;
  readonly currentOpVersion?: string;
}

export interface SubmissionRow {
  readonly id: string;
  readonly status: ModerationStatus;
  readonly autoDecision: AutoDecision;
  readonly priority: SubmissionPriority;
  readonly riskScore: number;
  readonly creatorHandle: string;
  readonly slug: string;
  readonly name: string;
  readonly draftId: string | null;
  readonly storeSkillId: string | null;
  readonly slaDeadline: string | null;
  readonly reviewer: string;
  readonly reviewerNotes: string;
  readonly rejectionReason: string;
  readonly rejectionCount: number;
  readonly submissionBanUntil: string | null;
  readonly suspensionReason: string;
  readonly submittedAt: string;
  readonly staticCompletedAt: string | null;
  readonly dynamicCompletedAt: string | null;
  readonly reviewedAt: string | null;
  readonly suspendedAt: string | null;
  readonly staticReport: StaticAnalysisReport | null;
  readonly dynamicReport: DynamicAnalysisReport | null;
  readonly manifest: SkillManifestInput;
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRow(r: typeof skillModerationSubmissions.$inferSelect): SubmissionRow {
  return {
    id: r.id,
    status: r.status as ModerationStatus,
    autoDecision: (r.autoDecision || "") as AutoDecision,
    priority: (r.priority || "standard") as SubmissionPriority,
    riskScore: r.riskScore,
    creatorHandle: r.creatorHandle,
    slug: r.slug,
    name: r.name,
    draftId: r.draftId,
    storeSkillId: r.storeSkillId,
    slaDeadline: r.slaDeadline ? new Date(r.slaDeadline).toISOString() : null,
    reviewer: r.reviewer,
    reviewerNotes: r.reviewerNotes,
    rejectionReason: r.rejectionReason,
    rejectionCount: r.rejectionCount,
    submissionBanUntil: r.submissionBanUntil
      ? new Date(r.submissionBanUntil).toISOString()
      : null,
    suspensionReason: r.suspensionReason,
    submittedAt: new Date(r.submittedAt).toISOString(),
    staticCompletedAt: r.staticCompletedAt
      ? new Date(r.staticCompletedAt).toISOString()
      : null,
    dynamicCompletedAt: r.dynamicCompletedAt
      ? new Date(r.dynamicCompletedAt).toISOString()
      : null,
    reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
    suspendedAt: r.suspendedAt ? new Date(r.suspendedAt).toISOString() : null,
    staticReport: parseJson<StaticAnalysisReport | null>(r.staticReport, null),
    dynamicReport: parseJson<DynamicAnalysisReport | null>(r.dynamicReport, null),
    manifest: parseJson<SkillManifestInput>(r.manifestJson, {}),
  };
}

async function loadSubmission(
  ctx: TenantContext,
  id: string,
): Promise<typeof skillModerationSubmissions.$inferSelect> {
  const rows = await db
    .select()
    .from(skillModerationSubmissions)
    .where(
      and(
        tenantScope(ctx, skillModerationSubmissions),
        eq(skillModerationSubmissions.id, id),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) throw new ModerationError(`Submission not found: ${id}`, "NOT_FOUND", 404);
  return r;
}

/**
 * Submit a skill for moderation. Runs the synchronous static + dynamic
 * pipeline inline so the creator gets pass/fail feedback in one call.
 * Returns the final `SubmissionRow` ready for polling.
 */
export async function submitSkillForModeration(
  ctx: TenantContext,
  input: SubmissionInput,
): Promise<SubmissionRow> {
  // Reject immediately if this slug is currently banned.
  if (input.creatorHandle && input.slug) {
    const banRow = await db
      .select()
      .from(skillModerationSubmissions)
      .where(
        and(
          eq(skillModerationSubmissions.creatorHandle, input.creatorHandle),
          eq(skillModerationSubmissions.slug, input.slug),
        ),
      )
      .orderBy(desc(skillModerationSubmissions.createdAt))
      .limit(1);
    const last = banRow[0];
    if (last?.submissionBanUntil && last.submissionBanUntil > Date.now()) {
      throw new ModerationError(
        `This slug is under a submission ban until ${new Date(last.submissionBanUntil).toISOString()}`,
        "SUBMISSION_BANNED",
        429,
      );
    }
  }

  const id = `sub_${nanoid()}`;
  const now = Date.now();
  const priority = input.priority ?? "standard";
  const slaDeadline = now + (priority === "verified" ? VERIFIED_SLA_MS : STANDARD_SLA_MS);

  await db.insert(skillModerationSubmissions).values(
    withTenantValues(ctx, {
      id,
      ...(input.draftId ? { draftId: input.draftId } : {}),
      ...(input.creatorId ? { creatorId: input.creatorId } : {}),
      creatorHandle: input.creatorHandle ?? "",
      slug: input.slug ?? "",
      name: input.name ?? input.manifest.name ?? "",
      source: input.source,
      manifestJson: JSON.stringify(input.manifest ?? {}),
      status: "static_running",
      priority,
      slaDeadline,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );

  // Stage 1 — static analysis.
  let staticReport: StaticAnalysisReport;
  try {
    staticReport = runStaticAnalysis({
      source: input.source,
      manifest: input.manifest,
      ...(input.currentOpVersion ? { currentOpVersion: input.currentOpVersion } : {}),
    });
  } catch (e) {
    await db
      .update(skillModerationSubmissions)
      .set({
        status: "static_failed",
        rejectionReason: `Static analysis crashed: ${e instanceof Error ? e.message : String(e)}`,
        updatedAt: Date.now(),
      })
      .where(eq(skillModerationSubmissions.id, id));
    return toRow(await loadSubmission(ctx, id));
  }

  await db
    .update(skillModerationSubmissions)
    .set({
      staticReport: JSON.stringify(staticReport),
      staticCompletedAt: Date.now(),
      riskScore: staticReport.riskScore,
      status: staticReport.safe ? "dynamic_running" : "rejected",
      autoDecision: staticReport.safe ? "" : "auto_rejected",
      rejectionReason: staticReport.safe ? "" : staticReport.summary,
      reviewedAt: staticReport.safe ? null : Date.now(),
      reviewer: staticReport.safe ? "" : "automated_pipeline",
      updatedAt: Date.now(),
    })
    .where(eq(skillModerationSubmissions.id, id));

  if (!staticReport.safe) {
    await onRejected(ctx, id, "static_analysis", staticReport.summary, input);
    return toRow(await loadSubmission(ctx, id));
  }

  // Stage 2 — dynamic analysis.
  let dynamicReport: DynamicAnalysisReport;
  try {
    dynamicReport = await runDynamicAnalysis({
      source: input.source,
      ...(input.manifest.networkHosts ? { declaredHosts: input.manifest.networkHosts } : {}),
      ...(input.manifest.fileScopes ? { declaredScopes: input.manifest.fileScopes } : {}),
    });
  } catch (e) {
    await db
      .update(skillModerationSubmissions)
      .set({
        status: "dynamic_failed",
        rejectionReason: `Dynamic analysis crashed: ${e instanceof Error ? e.message : String(e)}`,
        updatedAt: Date.now(),
      })
      .where(eq(skillModerationSubmissions.id, id));
    return toRow(await loadSubmission(ctx, id));
  }

  // Stage 3 — score & route.
  const compositeRisk = Math.min(
    100,
    Math.round(staticReport.riskScore * 0.5 + dynamicReport.riskScore * 0.5),
  );
  let status: ModerationStatus;
  let autoDecision: AutoDecision;
  let rejectionReason = "";

  if (!dynamicReport.safe || compositeRisk >= AUTO_REJECT_RISK_LIMIT) {
    status = "rejected";
    autoDecision = "auto_rejected";
    rejectionReason = dynamicReport.summary;
  } else if (compositeRisk <= AUTO_APPROVE_RISK_LIMIT && priority === "verified") {
    status = "approved";
    autoDecision = "auto_approved";
  } else {
    status = "awaiting_review";
    autoDecision = "queued_for_review";
  }

  await db
    .update(skillModerationSubmissions)
    .set({
      dynamicReport: JSON.stringify(dynamicReport),
      dynamicCompletedAt: Date.now(),
      riskScore: compositeRisk,
      status,
      autoDecision,
      rejectionReason,
      reviewedAt:
        status === "approved" || status === "rejected" ? Date.now() : null,
      reviewer: status === "awaiting_review" ? "" : "automated_pipeline",
      updatedAt: Date.now(),
    })
    .where(eq(skillModerationSubmissions.id, id));

  if (status === "rejected") {
    await onRejected(ctx, id, "dynamic_analysis", rejectionReason, input);
  } else if (status === "approved") {
    await appendAuditEntry(SYSTEM_CONTEXT, {
      actor: "automated_pipeline",
      action: "skill.moderation.auto_approve",
      resourceType: "skill_moderation_submission",
      resourceId: id,
      summary: `Auto-approved low-risk verified-creator submission (risk ${compositeRisk})`,
    });
  }

  return toRow(await loadSubmission(ctx, id));
}

async function onRejected(
  ctx: TenantContext,
  submissionId: string,
  stage: "static_analysis" | "dynamic_analysis" | "reviewer",
  reason: string,
  input?: SubmissionInput,
): Promise<void> {
  // Three-strike count: how many prior rejections does this slug already
  // have? If we just hit the third, set the 30-day submission ban.
  const handle = input?.creatorHandle;
  const slug = input?.slug;
  if (handle && slug) {
    const priorRejections = await db
      .select({ id: skillModerationSubmissions.id })
      .from(skillModerationSubmissions)
      .where(
        and(
          eq(skillModerationSubmissions.creatorHandle, handle),
          eq(skillModerationSubmissions.slug, slug),
          eq(skillModerationSubmissions.status, "rejected"),
          ne(skillModerationSubmissions.id, submissionId),
        ),
      );
    const count = priorRejections.length + 1;
    const ban = count >= 3 ? Date.now() + SUBMISSION_BAN_MS : null;
    await db
      .update(skillModerationSubmissions)
      .set({
        rejectionCount: count,
        submissionBanUntil: ban,
        updatedAt: Date.now(),
      })
      .where(eq(skillModerationSubmissions.id, submissionId));
  }

  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: "automated_pipeline",
    action: `skill.moderation.${stage}.reject`,
    resourceType: "skill_moderation_submission",
    resourceId: submissionId,
    summary: reason.slice(0, 500),
  });
  await logSecurityEvent(ctx, {
    eventType: "skill.moderation.reject",
    severity: "high",
    actor: "automated_pipeline",
    target: submissionId,
    detail: `${stage}: ${reason}`.slice(0, 1_000),
  });
}

/* ─── Reviewer actions ──────────────────────────────────────────────── */

export interface ReviewerAction {
  reviewer: string;
  notes?: string;
}

export async function approveSubmission(
  ctx: TenantContext,
  submissionId: string,
  action: ReviewerAction,
): Promise<SubmissionRow> {
  const row = await loadSubmission(ctx, submissionId);
  if (row.status !== "awaiting_review") {
    throw new ModerationError(
      `Cannot approve from status ${row.status}`,
      "BAD_STATUS",
      409,
    );
  }
  const now = Date.now();
  await db
    .update(skillModerationSubmissions)
    .set({
      status: "approved",
      reviewer: action.reviewer,
      reviewerNotes: action.notes ?? "",
      reviewedAt: now,
      updatedAt: now,
      version: row.version + 1,
    })
    .where(eq(skillModerationSubmissions.id, submissionId));
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: action.reviewer,
    action: "skill.moderation.reviewer_approve",
    resourceType: "skill_moderation_submission",
    resourceId: submissionId,
    summary: action.notes ?? `Approved by ${action.reviewer}`,
  });
  return toRow(await loadSubmission(ctx, submissionId));
}

export interface RejectSubmissionInput extends ReviewerAction {
  reason: string;
}

export async function rejectSubmission(
  ctx: TenantContext,
  submissionId: string,
  input: RejectSubmissionInput,
): Promise<SubmissionRow> {
  const row = await loadSubmission(ctx, submissionId);
  if (row.status === "approved") {
    throw new ModerationError("Already approved — use suspend instead", "BAD_STATUS", 409);
  }
  const now = Date.now();
  await db
    .update(skillModerationSubmissions)
    .set({
      status: "rejected",
      reviewer: input.reviewer,
      reviewerNotes: input.notes ?? "",
      rejectionReason: input.reason,
      reviewedAt: now,
      autoDecision: "",
      updatedAt: now,
      version: row.version + 1,
    })
    .where(eq(skillModerationSubmissions.id, submissionId));
  await onRejected(ctx, submissionId, "reviewer", input.reason, {
    source: row.source,
    manifest: parseJson<SkillManifestInput>(row.manifestJson, {}),
    creatorHandle: row.creatorHandle,
    slug: row.slug,
  });
  return toRow(await loadSubmission(ctx, submissionId));
}

export async function escalateSubmission(
  ctx: TenantContext,
  submissionId: string,
  action: ReviewerAction,
): Promise<SubmissionRow> {
  const row = await loadSubmission(ctx, submissionId);
  const now = Date.now();
  // Escalation extends SLA by another window so the senior reviewer has
  // breathing room.
  const newDeadline =
    (row.slaDeadline ?? now) +
    (row.priority === "verified" ? VERIFIED_SLA_MS : STANDARD_SLA_MS);
  await db
    .update(skillModerationSubmissions)
    .set({
      reviewer: action.reviewer,
      reviewerNotes: `[ESCALATED] ${action.notes ?? ""}`.trim(),
      slaDeadline: newDeadline,
      updatedAt: now,
      version: row.version + 1,
    })
    .where(eq(skillModerationSubmissions.id, submissionId));
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: action.reviewer,
    action: "skill.moderation.escalate",
    resourceType: "skill_moderation_submission",
    resourceId: submissionId,
    summary: action.notes ?? "Escalated to senior review",
  });
  return toRow(await loadSubmission(ctx, submissionId));
}

/* ─── Listing & filtering ───────────────────────────────────────────── */

export interface ListSubmissionsInput {
  status?: ModerationStatus;
  priority?: SubmissionPriority;
  cursor?: string | null;
  limit?: number;
}

export async function listSubmissions(
  ctx: TenantContext,
  input: ListSubmissionsInput,
): Promise<PaginatedData<SubmissionRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const filters = [tenantScope(ctx, skillModerationSubmissions)];
  if (input.status) filters.push(eq(skillModerationSubmissions.status, input.status));
  if (input.priority)
    filters.push(eq(skillModerationSubmissions.priority, input.priority));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(skillModerationSubmissions.createdAt, cursorTs));
  }
  const where = and(...filters);
  const rows = await db
    .select()
    .from(skillModerationSubmissions)
    .where(where)
    .orderBy(desc(skillModerationSubmissions.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map(toRow),
    limit,
    (r) => String(new Date(r.submittedAt).getTime()),
  );
}

export async function getSubmission(
  ctx: TenantContext,
  submissionId: string,
): Promise<SubmissionRow> {
  return toRow(await loadSubmission(ctx, submissionId));
}

/* ─── Appeals ───────────────────────────────────────────────────────── */

export interface AppealRow {
  id: string;
  submissionId: string;
  creatorHandle: string;
  reason: string;
  status: "pending" | "upheld" | "denied";
  seniorReviewer: string;
  decisionNotes: string;
  decidedAt: string | null;
  appealDeadline: string;
  createdAt: string;
}

function appealToRow(r: typeof skillModerationAppeals.$inferSelect): AppealRow {
  return {
    id: r.id,
    submissionId: r.submissionId,
    creatorHandle: r.creatorHandle,
    reason: r.reason,
    status: r.status as AppealRow["status"],
    seniorReviewer: r.seniorReviewer,
    decisionNotes: r.decisionNotes,
    decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
    appealDeadline: new Date(r.appealDeadline).toISOString(),
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function submitAppeal(
  ctx: TenantContext,
  input: { submissionId: string; reason: string; creatorHandle?: string; creatorId?: string },
): Promise<AppealRow> {
  const submission = await loadSubmission(ctx, input.submissionId);
  if (submission.status !== "rejected") {
    throw new ModerationError(
      `Only rejected submissions can be appealed (status=${submission.status})`,
      "BAD_STATUS",
      409,
    );
  }
  const reviewedAt = submission.reviewedAt ?? submission.updatedAt;
  const deadline = reviewedAt + APPEAL_WINDOW_MS;
  if (Date.now() > deadline) {
    throw new ModerationError(
      "Appeal window has closed (14 days from rejection)",
      "WINDOW_CLOSED",
      410,
    );
  }
  // Only one open appeal per submission.
  const existing = await db
    .select()
    .from(skillModerationAppeals)
    .where(
      and(
        eq(skillModerationAppeals.submissionId, input.submissionId),
        eq(skillModerationAppeals.status, "pending"),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new ModerationError(
      "An appeal for this submission is already pending",
      "DUPLICATE_APPEAL",
      409,
    );
  }
  const id = `app_${nanoid()}`;
  const now = Date.now();
  await db.insert(skillModerationAppeals).values(
    withTenantValues(ctx, {
      id,
      submissionId: input.submissionId,
      ...(input.creatorId ? { creatorId: input.creatorId } : {}),
      creatorHandle: input.creatorHandle ?? submission.creatorHandle ?? "",
      reason: input.reason,
      status: "pending",
      appealDeadline: deadline,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.creatorHandle ?? "creator",
    action: "skill.moderation.appeal_submitted",
    resourceType: "skill_moderation_appeal",
    resourceId: id,
    summary: input.reason.slice(0, 500),
  });
  const fresh = await db
    .select()
    .from(skillModerationAppeals)
    .where(eq(skillModerationAppeals.id, id))
    .limit(1);
  return appealToRow(fresh[0]!);
}

export async function listAppeals(
  ctx: TenantContext,
  input: { status?: "pending" | "upheld" | "denied"; cursor?: string | null; limit?: number },
): Promise<PaginatedData<AppealRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const filters = [tenantScope(ctx, skillModerationAppeals)];
  if (input.status) filters.push(eq(skillModerationAppeals.status, input.status));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(skillModerationAppeals.createdAt, cursorTs));
  }
  const rows = await db
    .select()
    .from(skillModerationAppeals)
    .where(and(...filters))
    .orderBy(desc(skillModerationAppeals.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map(appealToRow),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

export async function decideAppeal(
  ctx: TenantContext,
  appealId: string,
  input: { decision: "upheld" | "denied"; seniorReviewer: string; notes?: string },
): Promise<AppealRow> {
  const rows = await db
    .select()
    .from(skillModerationAppeals)
    .where(
      and(tenantScope(ctx, skillModerationAppeals), eq(skillModerationAppeals.id, appealId)),
    )
    .limit(1);
  const appeal = rows[0];
  if (!appeal) throw new ModerationError("Appeal not found", "NOT_FOUND", 404);
  if (appeal.status !== "pending") {
    throw new ModerationError(
      `Appeal already decided (${appeal.status})`,
      "BAD_STATUS",
      409,
    );
  }
  // Senior-reviewer-not-original-reviewer rule.
  const submission = await loadSubmission(ctx, appeal.submissionId);
  if (
    submission.reviewer &&
    submission.reviewer === input.seniorReviewer &&
    submission.reviewer !== "automated_pipeline"
  ) {
    throw new ModerationError(
      "Senior reviewer cannot be the same person who issued the original rejection",
      "REVIEWER_CONFLICT",
      409,
    );
  }
  const now = Date.now();
  await db
    .update(skillModerationAppeals)
    .set({
      status: input.decision,
      seniorReviewer: input.seniorReviewer,
      decisionNotes: input.notes ?? "",
      decidedAt: now,
      updatedAt: now,
      version: appeal.version + 1,
    })
    .where(eq(skillModerationAppeals.id, appealId));

  // If upheld, restore the submission to awaiting_review so a fresh
  // moderator decision can run.
  if (input.decision === "upheld") {
    await db
      .update(skillModerationSubmissions)
      .set({
        status: "awaiting_review",
        rejectionReason: "",
        reviewer: "",
        reviewerNotes: `Appeal upheld by ${input.seniorReviewer}`,
        slaDeadline: now + STANDARD_SLA_MS,
        updatedAt: now,
        version: submission.version + 1,
      })
      .where(eq(skillModerationSubmissions.id, appeal.submissionId));
  }

  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.seniorReviewer,
    action: `skill.moderation.appeal_${input.decision}`,
    resourceType: "skill_moderation_appeal",
    resourceId: appealId,
    summary: input.notes ?? `Appeal ${input.decision}`,
  });
  const fresh = await db
    .select()
    .from(skillModerationAppeals)
    .where(eq(skillModerationAppeals.id, appealId))
    .limit(1);
  return appealToRow(fresh[0]!);
}

/* ─── Post-publish monitoring ───────────────────────────────────────── */

export interface RescanRow {
  id: string;
  storeSkillId: string | null;
  submissionId: string | null;
  creatorHandle: string;
  slug: string;
  trigger: string;
  severity: string;
  finding: string;
  actor: string;
  suspended: boolean;
  createdAt: string;
}

function rescanToRow(r: typeof skillModerationRescans.$inferSelect): RescanRow {
  return {
    id: r.id,
    storeSkillId: r.storeSkillId,
    submissionId: r.submissionId,
    creatorHandle: r.creatorHandle,
    slug: r.slug,
    trigger: r.trigger,
    severity: r.severity,
    finding: r.finding,
    actor: r.actor,
    suspended: Boolean(r.suspended),
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

async function recordRescan(
  ctx: TenantContext,
  input: {
    submissionId?: string;
    storeSkillId?: string;
    creatorHandle: string;
    slug: string;
    trigger: string;
    severity: string;
    finding: string;
    detail?: unknown;
    actor?: string;
    suspended?: boolean;
  },
): Promise<void> {
  await db.insert(skillModerationRescans).values(
    withTenantValues(ctx, {
      id: `rsc_${nanoid()}`,
      ...(input.submissionId ? { submissionId: input.submissionId } : {}),
      ...(input.storeSkillId ? { storeSkillId: input.storeSkillId } : {}),
      creatorHandle: input.creatorHandle,
      slug: input.slug,
      trigger: input.trigger,
      severity: input.severity,
      finding: input.finding.slice(0, 500),
      detail: JSON.stringify(input.detail ?? {}),
      actor: input.actor ?? "system",
      suspended: input.suspended ?? false,
    }),
  );
}

/**
 * Walk every published, latest-version store skill and re-audit its
 * declared dependency map against the bundled vulnerability database.
 * If new high/critical CVEs are found the skill is auto-suspended and a
 * rescan row is written. Returns the count of skills affected.
 */
export async function rescanForVulnerabilities(): Promise<{
  scanned: number;
  affected: number;
  suspended: number;
}> {
  const rows = await db
    .select()
    .from(storeSkills)
    .where(eq(storeSkills.isLatest, true));
  let affected = 0;
  let suspended = 0;
  for (const skill of rows) {
    // Find the matching submission (latest) to read the manifest from.
    const submissionRows = await db
      .select()
      .from(skillModerationSubmissions)
      .where(
        and(
          eq(skillModerationSubmissions.creatorHandle, skill.creatorHandle),
          eq(skillModerationSubmissions.slug, skill.slug),
        ),
      )
      .orderBy(desc(skillModerationSubmissions.createdAt))
      .limit(1);
    const submission = submissionRows[0];
    if (!submission) continue;
    const manifest = parseJson<SkillManifestInput>(submission.manifestJson, {});
    const audit = auditDependencies(manifest.dependencies ?? {});
    if (audit.count === 0) continue;
    affected += 1;
    const blocking =
      audit.highestSeverity === "critical" || audit.highestSeverity === "high";
    if (blocking) {
      suspended += 1;
      await db
        .update(storeSkills)
        .set({ isLatest: false, updatedAt: Date.now() })
        .where(eq(storeSkills.id, skill.id));
      await db
        .update(skillModerationSubmissions)
        .set({
          status: "suspended",
          suspendedAt: Date.now(),
          suspensionReason: `Dependency CVE rescan: ${audit.vulnerabilities[0]?.cve}`,
          updatedAt: Date.now(),
          version: submission.version + 1,
        })
        .where(eq(skillModerationSubmissions.id, submission.id));
    }
    await recordRescan(SYSTEM_CONTEXT, {
      submissionId: submission.id,
      storeSkillId: skill.id,
      creatorHandle: skill.creatorHandle,
      slug: skill.slug,
      trigger: "dependency_cve",
      severity: audit.highestSeverity === "none" ? "info" : audit.highestSeverity,
      finding: `${audit.count} dependency vulnerabilit${audit.count === 1 ? "y" : "ies"}`,
      detail: audit,
      actor: "system",
      suspended: blocking,
    });
  }
  logger.info(
    { scanned: rows.length, affected, suspended },
    "skill moderation dependency rescan complete",
  );
  return { scanned: rows.length, affected, suspended };
}

/**
 * Emergency suspension of a published skill (Super Admin action). Flips
 * `is_latest=false` on the store row, stamps the submission, and logs
 * the rescan + audit entry. Reversible via `unsuspendStoreSkill`.
 */
export async function emergencySuspendStoreSkill(input: {
  storeSkillId: string;
  reviewer: string;
  reason: string;
}): Promise<{ suspended: boolean; rescanId: string }> {
  const rows = await db
    .select()
    .from(storeSkills)
    .where(eq(storeSkills.id, input.storeSkillId))
    .limit(1);
  const skill = rows[0];
  if (!skill) throw new ModerationError("Store skill not found", "NOT_FOUND", 404);
  await db
    .update(storeSkills)
    .set({ isLatest: false, updatedAt: Date.now() })
    .where(eq(storeSkills.id, input.storeSkillId));

  // Mark the latest submission as suspended.
  const submissionRows = await db
    .select()
    .from(skillModerationSubmissions)
    .where(
      and(
        eq(skillModerationSubmissions.creatorHandle, skill.creatorHandle),
        eq(skillModerationSubmissions.slug, skill.slug),
      ),
    )
    .orderBy(desc(skillModerationSubmissions.createdAt))
    .limit(1);
  const submission = submissionRows[0];
  if (submission) {
    await db
      .update(skillModerationSubmissions)
      .set({
        status: "suspended",
        suspendedAt: Date.now(),
        suspensionReason: input.reason,
        reviewer: input.reviewer,
        updatedAt: Date.now(),
        version: submission.version + 1,
      })
      .where(eq(skillModerationSubmissions.id, submission.id));
  }

  const rescanId = `rsc_${nanoid()}`;
  await db.insert(skillModerationRescans).values(
    withTenantValues(SYSTEM_CONTEXT, {
      id: rescanId,
      ...(submission ? { submissionId: submission.id } : {}),
      storeSkillId: input.storeSkillId,
      creatorHandle: skill.creatorHandle,
      slug: skill.slug,
      trigger: "emergency",
      severity: "critical",
      finding: input.reason.slice(0, 500),
      detail: JSON.stringify({ reason: input.reason }),
      actor: input.reviewer,
      suspended: true,
    }),
  );
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reviewer,
    action: "skill.moderation.emergency_suspend",
    resourceType: "store_skill",
    resourceId: input.storeSkillId,
    summary: `Emergency suspension: ${input.reason}`,
  });
  await logSecurityEvent(SYSTEM_CONTEXT, {
    eventType: "skill.moderation.emergency_suspend",
    severity: "critical",
    actor: input.reviewer,
    target: input.storeSkillId,
    detail: input.reason,
  });
  return { suspended: true, rescanId };
}

/**
 * Anomaly trigger — call when a published skill's usage pattern
 * shifts dramatically (e.g. 10x outbound calls). Records a rescan row
 * and queues the latest submission for re-review.
 */
export async function flagAnomaly(input: {
  storeSkillId: string;
  finding: string;
  multiplier: number;
}): Promise<RescanRow> {
  const rows = await db
    .select()
    .from(storeSkills)
    .where(eq(storeSkills.id, input.storeSkillId))
    .limit(1);
  const skill = rows[0];
  if (!skill) throw new ModerationError("Store skill not found", "NOT_FOUND", 404);
  const id = `rsc_${nanoid()}`;
  const blocking = input.multiplier >= 10;
  await db.insert(skillModerationRescans).values(
    withTenantValues(SYSTEM_CONTEXT, {
      id,
      storeSkillId: input.storeSkillId,
      creatorHandle: skill.creatorHandle,
      slug: skill.slug,
      trigger: "anomaly",
      severity: blocking ? "high" : "medium",
      finding: input.finding,
      detail: JSON.stringify({ multiplier: input.multiplier }),
      actor: "system",
      suspended: blocking,
    }),
  );
  if (blocking) {
    await db
      .update(storeSkills)
      .set({ isLatest: false, updatedAt: Date.now() })
      .where(eq(storeSkills.id, input.storeSkillId));
  }
  const fresh = await db
    .select()
    .from(skillModerationRescans)
    .where(eq(skillModerationRescans.id, id))
    .limit(1);
  return rescanToRow(fresh[0]!);
}

/**
 * User report → automatic temporary suspension and priority re-review.
 */
export async function suspendOnUserReport(input: {
  storeSkillId: string;
  reportId: string;
  reporter: string;
  reason: string;
}): Promise<RescanRow> {
  const rows = await db
    .select()
    .from(storeSkills)
    .where(eq(storeSkills.id, input.storeSkillId))
    .limit(1);
  const skill = rows[0];
  if (!skill) throw new ModerationError("Store skill not found", "NOT_FOUND", 404);
  await db
    .update(storeSkills)
    .set({ isLatest: false, updatedAt: Date.now() })
    .where(eq(storeSkills.id, input.storeSkillId));
  const id = `rsc_${nanoid()}`;
  await db.insert(skillModerationRescans).values(
    withTenantValues(SYSTEM_CONTEXT, {
      id,
      storeSkillId: input.storeSkillId,
      creatorHandle: skill.creatorHandle,
      slug: skill.slug,
      trigger: "user_report",
      severity: "high",
      finding: input.reason.slice(0, 500),
      detail: JSON.stringify({ reportId: input.reportId, reporter: input.reporter }),
      actor: input.reporter,
      suspended: true,
    }),
  );
  await appendAuditEntry(SYSTEM_CONTEXT, {
    actor: input.reporter,
    action: "skill.moderation.suspend_user_report",
    resourceType: "store_skill",
    resourceId: input.storeSkillId,
    summary: `Auto-suspended after user report: ${input.reason}`,
  });
  const fresh = await db
    .select()
    .from(skillModerationRescans)
    .where(eq(skillModerationRescans.id, id))
    .limit(1);
  return rescanToRow(fresh[0]!);
}

export async function listRescans(
  ctx: TenantContext,
  input: { storeSkillId?: string; cursor?: string | null; limit?: number },
): Promise<PaginatedData<RescanRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const filters = [tenantScope(ctx, skillModerationRescans)];
  if (input.storeSkillId)
    filters.push(eq(skillModerationRescans.storeSkillId, input.storeSkillId));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(skillModerationRescans.createdAt, cursorTs));
  }
  const rows = await db
    .select()
    .from(skillModerationRescans)
    .where(and(...filters))
    .orderBy(desc(skillModerationRescans.createdAt))
    .limit(limit + 1);
  return buildPage(
    rows.map(rescanToRow),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

/**
 * Helper used by the scheduler to find submissions about to breach SLA.
 * Returns the count for surfacing in the Super Admin dashboard.
 */
export async function listOverdueQueue(
  ctx: TenantContext,
): Promise<{
  total: number;
  overdue: number;
}> {
  const now = Date.now();
  const queueWhere = and(
    tenantScope(ctx, skillModerationSubmissions),
    eq(skillModerationSubmissions.status, "awaiting_review"),
  );
  const all = await db
    .select()
    .from(skillModerationSubmissions)
    .where(queueWhere);
  const overdue = all.filter(
    (r) => r.slaDeadline !== null && r.slaDeadline < now,
  ).length;
  return { total: all.length, overdue };
}

// Helper kept for completeness — not currently consumed but useful for
// future cleanup that wants to find submissions whose appeal window has
// closed.
export async function _expiredAppealCutoffSql(): Promise<unknown> {
  return and(
    eq(skillModerationAppeals.status, "pending"),
    lt(skillModerationAppeals.appealDeadline, Date.now()),
    isNull(skillModerationAppeals.decidedAt),
    gte(skillModerationAppeals.appealDeadline, 0),
  );
}
