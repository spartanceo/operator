/**
 * VoIP service — outbound + inbound calls via Twilio with on-box Whisper
 * transcription and a local-LLM post-call summary.
 *
 * Tier 1 stubs:
 *   - The Twilio call placement is a `// PROVIDER STUB` block that just
 *     stamps a synthetic CallSid and queues the row.
 *   - `transcribeCall` accepts a transcript inline so tests don't need a
 *     real audio file. The future hook calls Whisper against
 *     `recordingPath` and writes the result back here.
 *   - `summariseCall` accepts a summary inline; the future hook calls the
 *     local Ollama model with the transcript.
 *
 * Recording paths are local-only — Section 12 of the project context
 * forbids uploading raw audio to any cloud service.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  voipCalls,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logPrivacyEvent } from "../privacy.service";
import { requireConnectedAccount } from "./accounts.service";
import { findOrCreateByPhone, getContact } from "./contacts.service";
import { logInteraction } from "./interactions.service";

export type CallDirection = "inbound" | "outbound";
export type CallStatus =
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "failed"
  | "no_answer";

export interface VoipCallRow {
  id: string;
  accountId: string;
  contactId: string | null;
  providerCallId: string | null;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  status: CallStatus;
  durationSeconds: number | null;
  transcript: string | null;
  summary: string | null;
  recordingPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceCallInput {
  accountId: string;
  toNumber: string;
  /** Optional contact id — when omitted we lookup-or-create by toNumber. */
  contactId?: string;
}

export interface RecordCallInput {
  accountId: string;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  status?: CallStatus;
  durationSeconds?: number;
  startedAt?: number;
  completedAt?: number;
  recordingPath?: string;
  transcript?: string;
  summary?: string;
  contactId?: string;
}

function toRow(r: typeof voipCalls.$inferSelect): VoipCallRow {
  return {
    id: r.id,
    accountId: r.accountId,
    contactId: r.contactId,
    providerCallId: r.providerCallId,
    direction: r.direction as CallDirection,
    fromNumber: r.fromNumber,
    toNumber: r.toNumber,
    status: r.status as CallStatus,
    durationSeconds: r.durationSeconds,
    transcript: r.transcript,
    summary: r.summary,
    recordingPath: r.recordingPath,
    startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function deriveDisplayName(phone: string): string {
  return phone;
}

async function resolveContactId(
  ctx: TenantContext,
  explicit: string | undefined,
  phone: string,
): Promise<string> {
  if (explicit) {
    const c = await getContact(ctx, explicit);
    if (c) return c.id;
  }
  const c = await findOrCreateByPhone(ctx, phone, deriveDisplayName(phone));
  return c.id;
}

/**
 * Place an outbound call. Tier 1 leaves the actual Twilio HTTP call
 * stubbed; the row lands in `queued` and the caller (or a future Twilio
 * webhook) advances it through `ringing` → `in_progress` → `completed`
 * via `updateCallStatus`.
 */
export async function placeCall(
  ctx: TenantContext,
  input: PlaceCallInput,
): Promise<VoipCallRow> {
  const account = await requireConnectedAccount(ctx, input.accountId, "voip");
  const meta = (account.metadata ?? {}) as Record<string, unknown>;
  const fromNumber =
    typeof meta["phoneNumber"] === "string" ? (meta["phoneNumber"] as string) : account.label;
  const contactId = await resolveContactId(ctx, input.contactId, input.toNumber);
  const id = `call_${nanoid()}`;
  // PROVIDER STUB: real impl POSTs to Twilio API, captures CallSid.
  const providerCallId = `stub_${nanoid()}`;
  await db.insert(voipCalls).values(
    withTenantValues(ctx, {
      id,
      accountId: input.accountId,
      contactId,
      providerCallId,
      direction: "outbound" as const,
      fromNumber,
      toNumber: input.toNumber,
      status: "queued" as const,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "comm.voip.call_placed",
    actor: "agent",
    target: input.toNumber,
    severity: "high",
    detail: `Outbound call queued via ${account.provider}`,
  });
  await logInteraction(ctx, {
    contactId,
    kind: "call_out",
    referenceId: id,
    summary: `Outbound call to ${input.toNumber}`,
    occurredAt: Date.now(),
  });
  const row = await getCall(ctx, id);
  if (!row) throw new Error("Call not found after insert");
  return row;
}

/**
 * Record a call that already happened (inbound webhook, or outbound
 * completion). Used by the Twilio status webhook in the future hardening
 * pass; for Tier 1 it's the path tests use to load fixture call rows.
 */
export async function recordCall(
  ctx: TenantContext,
  input: RecordCallInput,
): Promise<VoipCallRow> {
  const account = await requireConnectedAccount(ctx, input.accountId, "voip");
  const otherNumber =
    input.direction === "inbound" ? input.fromNumber : input.toNumber;
  const contactId = await resolveContactId(ctx, input.contactId, otherNumber);
  const id = `call_${nanoid()}`;
  const startedAt = input.startedAt ?? Date.now();
  await db.insert(voipCalls).values(
    withTenantValues(ctx, {
      id,
      accountId: input.accountId,
      contactId,
      providerCallId: `stub_${nanoid()}`,
      direction: input.direction,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      status: input.status ?? "completed",
      durationSeconds: input.durationSeconds ?? null,
      transcript: input.transcript ?? null,
      summary: input.summary ?? null,
      recordingPath: input.recordingPath ?? null,
      startedAt,
      completedAt: input.completedAt ?? null,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType:
      input.direction === "inbound" ? "comm.voip.call_received" : "comm.voip.call_logged",
    actor: input.direction === "inbound" ? "system" : "agent",
    target: otherNumber,
    severity: "medium",
    detail: `${input.direction} call via ${account.provider}`,
  });
  await logInteraction(ctx, {
    contactId,
    kind: input.direction === "inbound" ? "call_in" : "call_out",
    referenceId: id,
    summary: `${input.direction} call ${otherNumber}`,
    occurredAt: startedAt,
  });
  const row = await getCall(ctx, id);
  if (!row) throw new Error("Call not found after insert");
  return row;
}

export async function getCall(
  ctx: TenantContext,
  id: string,
): Promise<VoipCallRow | null> {
  const rows = await db
    .select()
    .from(voipCalls)
    .where(and(tenantScope(ctx, voipCalls), eq(voipCalls.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listCalls(
  ctx: TenantContext,
  opts: {
    accountId?: string;
    direction?: CallDirection;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<PaginatedData<VoipCallRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, voipCalls)];
  if (opts.accountId) conditions.push(eq(voipCalls.accountId, opts.accountId));
  if (opts.direction) conditions.push(eq(voipCalls.direction, opts.direction));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(voipCalls.createdAt, cursorTs));
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = await db
    .select()
    .from(voipCalls)
    .where(where)
    .orderBy(desc(voipCalls.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function updateCallStatus(
  ctx: TenantContext,
  id: string,
  patch: {
    status?: CallStatus;
    durationSeconds?: number;
    completedAt?: number;
    recordingPath?: string;
  },
): Promise<VoipCallRow | null> {
  const existing = await getCall(ctx, id);
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.status !== undefined) set["status"] = patch.status;
  if (patch.durationSeconds !== undefined)
    set["durationSeconds"] = patch.durationSeconds;
  if (patch.completedAt !== undefined) set["completedAt"] = patch.completedAt;
  if (patch.recordingPath !== undefined) set["recordingPath"] = patch.recordingPath;
  await db
    .update(voipCalls)
    .set(set)
    .where(and(tenantScope(ctx, voipCalls), eq(voipCalls.id, id)));
  return getCall(ctx, id);
}

/**
 * Whisper transcription stub — accepts the transcript inline. The
 * production hook will read the recording from `recordingPath` and run it
 * through the on-box Whisper model.
 */
export async function transcribeCall(
  ctx: TenantContext,
  id: string,
  transcript: string,
): Promise<VoipCallRow | null> {
  const existing = await getCall(ctx, id);
  if (!existing) return null;
  await db
    .update(voipCalls)
    .set({ transcript, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, voipCalls), eq(voipCalls.id, id)));
  await logPrivacyEvent(ctx, {
    eventType: "comm.voip.call_transcribed",
    actor: "system",
    target: existing.toNumber,
    severity: "low",
    detail: `Whisper transcript stored for ${id}`,
  });
  return getCall(ctx, id);
}

/** Local-LLM post-call summary stub. */
export async function summariseCall(
  ctx: TenantContext,
  id: string,
  summary: string,
): Promise<VoipCallRow | null> {
  const existing = await getCall(ctx, id);
  if (!existing) return null;
  await db
    .update(voipCalls)
    .set({ summary, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, voipCalls), eq(voipCalls.id, id)));
  return getCall(ctx, id);
}
