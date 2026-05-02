/**
 * Email service — read/triage/draft/send for connected Gmail and Outlook
 * accounts.
 *
 * Tier 1 stubs the actual provider HTTP calls: tokens are stored locally,
 * mail is mirrored into `email_messages`, drafts are queued in
 * `email_drafts`, and `sendDraft` flips the row to `sent` after writing a
 * privacy event. The point is to ship the contract end-to-end so the
 * approval gate, the contact log, and the outreach reply-stop are all
 * exercised without needing a real OAuth dance during tests.
 *
 * Send is approval-gated — drafts created via `createDraft` start in
 * `decision = 'pending'` and only `sendDraft` (called after the user
 * approves) actually delivers and writes the `email_messages` row.
 */
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  emailDrafts,
  emailMessages,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "../privacy.service";
import { requireConnectedAccount } from "./accounts.service";
import { findOrCreateByEmail } from "./contacts.service";
import { logInteraction } from "./interactions.service";

export type EmailDirection = "inbound" | "outbound";
export type EmailFolder = "inbox" | "sent" | "archived" | "spam" | "trash";
export type EmailStatus = "unread" | "read" | "replied" | "archived";
export type DraftDecision = "pending" | "approved" | "denied" | "sent";

export interface EmailMessageRow {
  id: string;
  accountId: string;
  providerMessageId: string | null;
  threadId: string | null;
  direction: EmailDirection;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  snippet: string;
  body: string;
  folder: EmailFolder;
  status: EmailStatus;
  category: string | null;
  receivedAt: string;
  createdAt: string;
}

export interface EmailDraftRow {
  id: string;
  accountId: string;
  replyToMessageId: string | null;
  sequenceId: string | null;
  enrolmentId: string | null;
  toAddresses: string[];
  subject: string;
  body: string;
  decision: DraftDecision;
  decidedAt: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestMessageInput {
  accountId: string;
  providerMessageId?: string;
  threadId?: string;
  direction?: EmailDirection;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  body: string;
  snippet?: string;
  folder?: EmailFolder;
  category?: string;
  receivedAt?: number;
}

export interface CreateDraftInput {
  accountId: string;
  toAddresses: string[];
  subject: string;
  body: string;
  replyToMessageId?: string;
  sequenceId?: string;
  enrolmentId?: string;
}

function toMessageRow(r: typeof emailMessages.$inferSelect): EmailMessageRow {
  return {
    id: r.id,
    accountId: r.accountId,
    providerMessageId: r.providerMessageId,
    threadId: r.threadId,
    direction: r.direction as EmailDirection,
    fromAddress: r.fromAddress,
    toAddresses: JSON.parse(r.toAddresses) as string[],
    subject: r.subject,
    snippet: r.snippet,
    body: r.body,
    folder: r.folder as EmailFolder,
    status: r.status as EmailStatus,
    category: r.category,
    receivedAt: new Date(r.receivedAt).toISOString(),
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function toDraftRow(r: typeof emailDrafts.$inferSelect): EmailDraftRow {
  return {
    id: r.id,
    accountId: r.accountId,
    replyToMessageId: r.replyToMessageId,
    sequenceId: r.sequenceId,
    enrolmentId: r.enrolmentId,
    toAddresses: JSON.parse(r.toAddresses) as string[],
    subject: r.subject,
    body: r.body,
    decision: r.decision as DraftDecision,
    decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
    sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
    providerMessageId: r.providerMessageId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function deriveSnippet(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

function deriveDisplayName(email: string): string {
  return email.split("@")[0] ?? email;
}

/**
 * Pull a message into the local mirror. In Tier 1 this is called by tests
 * and the outreach reply-detection path; once a real Gmail/Outlook poller
 * lands it will be the funnel for fetched messages too.
 */
export async function ingestMessage(
  ctx: TenantContext,
  input: IngestMessageInput,
): Promise<EmailMessageRow> {
  await requireConnectedAccount(ctx, input.accountId, "email");
  const id = `emsg_${nanoid()}`;
  const direction = input.direction ?? "inbound";
  const receivedAt = input.receivedAt ?? Date.now();
  const snippet = input.snippet ?? deriveSnippet(input.body);
  await db.insert(emailMessages).values(
    withTenantValues(ctx, {
      id,
      accountId: input.accountId,
      providerMessageId: input.providerMessageId ?? null,
      threadId: input.threadId ?? null,
      direction,
      fromAddress: input.fromAddress,
      toAddresses: JSON.stringify(input.toAddresses),
      subject: input.subject,
      snippet,
      body: input.body,
      folder: input.folder ?? (direction === "inbound" ? "inbox" : "sent"),
      status: direction === "inbound" ? "unread" : "read",
      category: input.category ?? null,
      receivedAt,
    }),
  );
  // Auto-log to CRM: contact = the other party, kind = inbound or outbound.
  const contactEmail = direction === "inbound" ? input.fromAddress : input.toAddresses[0];
  if (contactEmail) {
    const contact = await findOrCreateByEmail(
      ctx,
      contactEmail,
      deriveDisplayName(contactEmail),
    );
    await logInteraction(ctx, {
      contactId: contact.id,
      kind: direction === "inbound" ? "email_in" : "email_out",
      referenceId: id,
      summary: input.subject,
      occurredAt: receivedAt,
    });
  }
  const row = await getMessage(ctx, id);
  if (!row) throw new Error("Message not found after insert");
  return row;
}

export async function getMessage(
  ctx: TenantContext,
  id: string,
): Promise<EmailMessageRow | null> {
  const rows = await db
    .select()
    .from(emailMessages)
    .where(and(tenantScope(ctx, emailMessages), eq(emailMessages.id, id)))
    .limit(1);
  return rows[0] ? toMessageRow(rows[0]) : null;
}

export async function listMessages(
  ctx: TenantContext,
  opts: {
    accountId?: string;
    folder?: EmailFolder;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<PaginatedData<EmailMessageRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, emailMessages)];
  if (opts.accountId) conditions.push(eq(emailMessages.accountId, opts.accountId));
  if (opts.folder) conditions.push(eq(emailMessages.folder, opts.folder));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(emailMessages.receivedAt, cursorTs));
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = await db
    .select()
    .from(emailMessages)
    .where(where)
    .orderBy(desc(emailMessages.receivedAt))
    .limit(limit + 1);
  return buildPage(rows.map(toMessageRow), limit, (r) =>
    String(new Date(r.receivedAt).getTime()),
  );
}

/** Triage: flip a message's status. Used for read/replied/archived. */
export async function setMessageStatus(
  ctx: TenantContext,
  id: string,
  status: EmailStatus,
): Promise<EmailMessageRow | null> {
  const existing = await getMessage(ctx, id);
  if (!existing) return null;
  await db
    .update(emailMessages)
    .set({ status, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, emailMessages), eq(emailMessages.id, id)));
  return getMessage(ctx, id);
}

/** Categorise a message (AI-assigned label). */
export async function categoriseMessage(
  ctx: TenantContext,
  id: string,
  category: string,
): Promise<EmailMessageRow | null> {
  const existing = await getMessage(ctx, id);
  if (!existing) return null;
  await db
    .update(emailMessages)
    .set({ category, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, emailMessages), eq(emailMessages.id, id)));
  return getMessage(ctx, id);
}

export async function createDraft(
  ctx: TenantContext,
  input: CreateDraftInput,
): Promise<EmailDraftRow> {
  await requireConnectedAccount(ctx, input.accountId, "email");
  const id = `edr_${nanoid()}`;
  await db.insert(emailDrafts).values(
    withTenantValues(ctx, {
      id,
      accountId: input.accountId,
      replyToMessageId: input.replyToMessageId ?? null,
      sequenceId: input.sequenceId ?? null,
      enrolmentId: input.enrolmentId ?? null,
      toAddresses: JSON.stringify(input.toAddresses),
      subject: input.subject,
      body: input.body,
      decision: "pending" as const,
    }),
  );
  const row = await getDraft(ctx, id);
  if (!row) throw new Error("Draft not found after insert");
  return row;
}

export async function getDraft(
  ctx: TenantContext,
  id: string,
): Promise<EmailDraftRow | null> {
  const rows = await db
    .select()
    .from(emailDrafts)
    .where(and(tenantScope(ctx, emailDrafts), eq(emailDrafts.id, id)))
    .limit(1);
  return rows[0] ? toDraftRow(rows[0]) : null;
}

export async function listDrafts(
  ctx: TenantContext,
  opts: { decision?: DraftDecision; cursor?: string; limit?: number } = {},
): Promise<PaginatedData<EmailDraftRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, emailDrafts)];
  if (opts.decision) conditions.push(eq(emailDrafts.decision, opts.decision));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(emailDrafts.createdAt, cursorTs));
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = await db
    .select()
    .from(emailDrafts)
    .where(where)
    .orderBy(desc(emailDrafts.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toDraftRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

/**
 * Send a previously-approved draft. Writes a privacy event for the outbound
 * provider call, mirrors the message into `email_messages` so the sent-mail
 * folder shows it, marks the draft `sent`, and bumps the source message to
 * `replied` if this was a reply.
 */
export async function sendDraft(
  ctx: TenantContext,
  id: string,
): Promise<EmailMessageRow> {
  const draft = await getDraft(ctx, id);
  if (!draft) throw new Error(`Draft ${id} not found`);
  if (draft.decision === "sent") {
    throw new Error(`Draft ${id} already sent`);
  }
  const account = await requireConnectedAccount(ctx, draft.accountId, "email");

  // Look up the source message to inherit thread + from-address (Tier 1
  // stub: in the absence of a real provider, "from" is the account label).
  let threadId: string | null = null;
  let fromAddress = account.label;
  if (draft.replyToMessageId) {
    const source = await getMessage(ctx, draft.replyToMessageId);
    if (source) {
      threadId = source.threadId;
      fromAddress = source.toAddresses[0] ?? account.label;
    }
  }

  await logPrivacyEvent(ctx, {
    eventType: "comm.email.sent",
    actor: "agent",
    target: draft.toAddresses.join(","),
    severity: "medium",
    detail: `Sent draft ${id} via ${account.provider}`,
  });

  // Provider-side stub: synthesise a deterministic provider id so call
  // sites can still link the local row to "what was sent".
  const providerMessageId = `stub_${nanoid()}`;
  const sentAt = Date.now();

  const sentRow = await ingestMessage(ctx, {
    accountId: draft.accountId,
    providerMessageId,
    threadId: threadId ?? `thr_${nanoid()}`,
    direction: "outbound",
    fromAddress,
    toAddresses: draft.toAddresses,
    subject: draft.subject,
    body: draft.body,
    folder: "sent",
    receivedAt: sentAt,
  });

  await db
    .update(emailDrafts)
    .set({
      decision: "sent",
      decidedAt: sentAt,
      sentAt,
      providerMessageId,
      updatedAt: sentAt,
    })
    .where(and(tenantScope(ctx, emailDrafts), eq(emailDrafts.id, id)));

  if (draft.replyToMessageId) {
    await setMessageStatus(ctx, draft.replyToMessageId, "replied");
  }

  return sentRow;
}

/** Mark a draft as denied — used by the approval flow. */
export async function denyDraft(
  ctx: TenantContext,
  id: string,
): Promise<EmailDraftRow | null> {
  const existing = await getDraft(ctx, id);
  if (!existing) return null;
  await db
    .update(emailDrafts)
    .set({ decision: "denied", decidedAt: Date.now(), updatedAt: Date.now() })
    .where(and(tenantScope(ctx, emailDrafts), eq(emailDrafts.id, id)));
  return getDraft(ctx, id);
}

/**
 * Detect the most recent inbound reply on a thread. Used by the outreach
 * runner to enforce reply-stop. Returns the message row when an inbound
 * message exists on the thread that arrived after the most recent outbound
 * one — the canonical "they replied to me" condition.
 */
export async function findReplyOnThread(
  ctx: TenantContext,
  threadId: string,
): Promise<EmailMessageRow | null> {
  const rows = await db
    .select()
    .from(emailMessages)
    .where(
      and(
        tenantScope(ctx, emailMessages),
        eq(emailMessages.threadId, threadId),
      ),
    )
    .orderBy(asc(emailMessages.receivedAt));
  let lastOutboundAt = 0;
  let reply: typeof emailMessages.$inferSelect | null = null;
  for (const r of rows) {
    if (r.direction === "outbound") {
      lastOutboundAt = r.receivedAt;
    } else if (r.direction === "inbound" && r.receivedAt > lastOutboundAt) {
      reply = r;
    }
  }
  return reply ? toMessageRow(reply) : null;
}
