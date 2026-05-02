/**
 * Outreach service — multi-step email sequences with reply-stop.
 *
 * A sequence is a list of `{ subject, body, delayDays }` steps. Enrolling
 * a contact creates an `outreach_enrolments` row scheduled for the first
 * step. `runDueSteps` walks every active enrolment whose `nextSendAt` has
 * passed and:
 *   1. Checks for inbound replies on the threaded conversation —
 *      if any, marks the enrolment `replied` and stops.
 *   2. Otherwise drafts the next step via the email service. The draft is
 *      auto-sent (Tier 1: outreach steps don't require per-step approval —
 *      the user approved the sequence at enrolment time).
 *   3. Advances `currentStep` and computes the next `nextSendAt` from
 *      the step's `delayDays`. When the last step fires the enrolment
 *      moves to `completed`.
 */
import { and, asc, desc, eq, lt, lte } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  contacts,
  db,
  decodeCursor,
  normaliseLimit,
  outreachEnrolments,
  outreachSequences,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { requireConnectedAccount } from "./accounts.service";
import { getContact } from "./contacts.service";
import {
  createDraft,
  findReplyOnThread,
  sendDraft,
} from "./email.service";

export interface OutreachStep {
  subject: string;
  body: string;
  delayDays: number;
}

export type SequenceStatus = "active" | "paused" | "archived";

export type EnrolmentStatus =
  | "active"
  | "completed"
  | "replied"
  | "paused"
  | "stopped";

export interface OutreachSequenceRow {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  steps: OutreachStep[];
  status: SequenceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachEnrolmentRow {
  id: string;
  sequenceId: string;
  contactId: string;
  status: EnrolmentStatus;
  currentStep: number;
  nextSendAt: string | null;
  lastSentAt: string | null;
  repliedAt: string | null;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSequenceInput {
  accountId: string;
  name: string;
  description?: string;
  steps: OutreachStep[];
}

export interface EnrolContactInput {
  sequenceId: string;
  contactId: string;
  /** Optional override — defaults to "now" so the first step fires
   *  immediately on the next runner tick. */
  startAt?: number;
}

export interface RunResult {
  enrolmentsScanned: number;
  stepsSent: number;
  repliesDetected: number;
  completed: number;
}

const DAY_MS = 24 * 60 * 60_000;

function toSequenceRow(r: typeof outreachSequences.$inferSelect): OutreachSequenceRow {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    description: r.description,
    steps: JSON.parse(r.stepsJson) as OutreachStep[],
    status: r.status as SequenceStatus,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toEnrolmentRow(
  r: typeof outreachEnrolments.$inferSelect,
): OutreachEnrolmentRow {
  return {
    id: r.id,
    sequenceId: r.sequenceId,
    contactId: r.contactId,
    status: r.status as EnrolmentStatus,
    currentStep: r.currentStep,
    nextSendAt: r.nextSendAt ? new Date(r.nextSendAt).toISOString() : null,
    lastSentAt: r.lastSentAt ? new Date(r.lastSentAt).toISOString() : null,
    repliedAt: r.repliedAt ? new Date(r.repliedAt).toISOString() : null,
    threadId: r.threadId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listSequences(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; status?: SequenceStatus } = {},
): Promise<PaginatedData<OutreachSequenceRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, outreachSequences)];
  if (opts.status) conditions.push(eq(outreachSequences.status, opts.status));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(outreachSequences.createdAt, cursorTs));
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = await db
    .select()
    .from(outreachSequences)
    .where(where)
    .orderBy(desc(outreachSequences.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toSequenceRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getSequence(
  ctx: TenantContext,
  id: string,
): Promise<OutreachSequenceRow | null> {
  const rows = await db
    .select()
    .from(outreachSequences)
    .where(and(tenantScope(ctx, outreachSequences), eq(outreachSequences.id, id)))
    .limit(1);
  return rows[0] ? toSequenceRow(rows[0]) : null;
}

export async function createSequence(
  ctx: TenantContext,
  input: CreateSequenceInput,
): Promise<OutreachSequenceRow> {
  await requireConnectedAccount(ctx, input.accountId, "email");
  if (input.steps.length === 0) throw new Error("Sequence requires at least one step");
  const id = `seq_${nanoid()}`;
  await db.insert(outreachSequences).values(
    withTenantValues(ctx, {
      id,
      accountId: input.accountId,
      name: input.name,
      description: input.description ?? null,
      stepsJson: JSON.stringify(input.steps),
      status: "active" as const,
    }),
  );
  const row = await getSequence(ctx, id);
  if (!row) throw new Error("Sequence not found after insert");
  return row;
}

export async function setSequenceStatus(
  ctx: TenantContext,
  id: string,
  status: SequenceStatus,
): Promise<OutreachSequenceRow | null> {
  const existing = await getSequence(ctx, id);
  if (!existing) return null;
  await db
    .update(outreachSequences)
    .set({ status, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, outreachSequences), eq(outreachSequences.id, id)));
  return getSequence(ctx, id);
}

export async function enrolContact(
  ctx: TenantContext,
  input: EnrolContactInput,
): Promise<OutreachEnrolmentRow> {
  const sequence = await getSequence(ctx, input.sequenceId);
  if (!sequence) throw new Error(`Sequence ${input.sequenceId} not found`);
  const contact = await getContact(ctx, input.contactId);
  if (!contact) throw new Error(`Contact ${input.contactId} not found`);
  if (!contact.email) throw new Error(`Contact ${input.contactId} has no email`);
  const id = `enr_${nanoid()}`;
  const nextSendAt = input.startAt ?? Date.now();
  await db.insert(outreachEnrolments).values(
    withTenantValues(ctx, {
      id,
      sequenceId: input.sequenceId,
      contactId: input.contactId,
      status: "active" as const,
      currentStep: 0,
      nextSendAt,
    }),
  );
  const row = await getEnrolment(ctx, id);
  if (!row) throw new Error("Enrolment not found after insert");
  return row;
}

export async function getEnrolment(
  ctx: TenantContext,
  id: string,
): Promise<OutreachEnrolmentRow | null> {
  const rows = await db
    .select()
    .from(outreachEnrolments)
    .where(and(tenantScope(ctx, outreachEnrolments), eq(outreachEnrolments.id, id)))
    .limit(1);
  return rows[0] ? toEnrolmentRow(rows[0]) : null;
}

export async function listEnrolments(
  ctx: TenantContext,
  opts: {
    sequenceId?: string;
    status?: EnrolmentStatus;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<PaginatedData<OutreachEnrolmentRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, outreachEnrolments)];
  if (opts.sequenceId) conditions.push(eq(outreachEnrolments.sequenceId, opts.sequenceId));
  if (opts.status) conditions.push(eq(outreachEnrolments.status, opts.status));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(outreachEnrolments.createdAt, cursorTs));
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = await db
    .select()
    .from(outreachEnrolments)
    .where(where)
    .orderBy(desc(outreachEnrolments.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toEnrolmentRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

/**
 * Process every active enrolment whose `nextSendAt <= now`. Returns
 * counters describing what changed so callers can surface progress.
 */
export async function runDueSteps(
  ctx: TenantContext,
  now: number = Date.now(),
): Promise<RunResult> {
  const due = await db
    .select()
    .from(outreachEnrolments)
    .where(
      and(
        tenantScope(ctx, outreachEnrolments),
        eq(outreachEnrolments.status, "active"),
        lte(outreachEnrolments.nextSendAt, now),
      ),
    )
    .orderBy(asc(outreachEnrolments.nextSendAt))
    .limit(100);

  let stepsSent = 0;
  let repliesDetected = 0;
  let completed = 0;

  for (const e of due) {
    // Reply-stop check first — never send another step on top of a reply.
    if (e.threadId) {
      const reply = await findReplyOnThread(ctx, e.threadId);
      if (reply) {
        await db
          .update(outreachEnrolments)
          .set({
            status: "replied",
            repliedAt: new Date(reply.receivedAt).getTime(),
            nextSendAt: null,
            updatedAt: Date.now(),
          })
          .where(
            and(tenantScope(ctx, outreachEnrolments), eq(outreachEnrolments.id, e.id)),
          );
        repliesDetected += 1;
        continue;
      }
    }

    const seqRows = await db
      .select()
      .from(outreachSequences)
      .where(
        and(
          tenantScope(ctx, outreachSequences),
          eq(outreachSequences.id, e.sequenceId),
        ),
      )
      .limit(1);
    const sequenceRow = seqRows[0];
    if (!sequenceRow) continue;
    const sequence = toSequenceRow(sequenceRow);
    if (sequence.status !== "active") continue;

    const step = sequence.steps[e.currentStep];
    if (!step) {
      await db
        .update(outreachEnrolments)
        .set({ status: "completed", nextSendAt: null, updatedAt: Date.now() })
        .where(
          and(tenantScope(ctx, outreachEnrolments), eq(outreachEnrolments.id, e.id)),
        );
      completed += 1;
      continue;
    }

    const contactRows = await db
      .select()
      .from(contacts)
      .where(and(tenantScope(ctx, contacts), eq(contacts.id, e.contactId)))
      .limit(1);
    const contact = contactRows[0];
    if (!contact || !contact.email) continue;

    const draft = await createDraft(ctx, {
      accountId: sequence.accountId,
      toAddresses: [contact.email],
      subject: step.subject,
      body: step.body,
      sequenceId: sequence.id,
      enrolmentId: e.id,
    });
    const sent = await sendDraft(ctx, draft.id);
    stepsSent += 1;

    const isLast = e.currentStep + 1 >= sequence.steps.length;
    const nextStep = sequence.steps[e.currentStep + 1];
    const nextSendAt = isLast || !nextStep
      ? null
      : now + Math.max(0, nextStep.delayDays) * DAY_MS;

    await db
      .update(outreachEnrolments)
      .set({
        currentStep: e.currentStep + 1,
        lastSentAt: now,
        nextSendAt,
        threadId: sent.threadId ?? e.threadId,
        status: isLast ? "completed" : "active",
        updatedAt: Date.now(),
      })
      .where(and(tenantScope(ctx, outreachEnrolments), eq(outreachEnrolments.id, e.id)));
    if (isLast) completed += 1;
  }

  return {
    enrolmentsScanned: due.length,
    stepsSent,
    repliesDetected,
    completed,
  };
}
