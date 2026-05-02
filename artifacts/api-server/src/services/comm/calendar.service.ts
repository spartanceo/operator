/**
 * Calendar service — read/write events on a connected Google or Apple
 * calendar plus a free-slot finder used by the meeting-scheduling agent.
 *
 * Tier 1 mirrors events into `calendar_events` and stubs the actual
 * provider call (a future pass swaps the `// PROVIDER STUB` block for
 * Google Calendar API / Apple ICS calls). Every create/update/delete
 * writes a privacy event so the user can audit what changed on their
 * calendar.
 */
import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  calendarEvents,
  db,
  decodeCursor,
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

export interface CalendarAttendee {
  email: string;
  name?: string;
  response?: "accepted" | "declined" | "tentative" | "needs_action";
}

export type CalendarStatus = "confirmed" | "tentative" | "cancelled";

export interface CalendarEventRow {
  id: string;
  accountId: string;
  providerEventId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  attendees: CalendarAttendee[];
  startsAt: string;
  endsAt: string;
  status: CalendarStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEventInput {
  accountId: string;
  title: string;
  startsAt: number;
  endsAt: number;
  description?: string;
  location?: string;
  attendees?: CalendarAttendee[];
}

export interface UpdateEventInput {
  title?: string;
  description?: string | null;
  location?: string | null;
  attendees?: CalendarAttendee[];
  startsAt?: number;
  endsAt?: number;
  status?: CalendarStatus;
}

export interface FreeSlot {
  startsAt: string;
  endsAt: string;
}

function toRow(r: typeof calendarEvents.$inferSelect): CalendarEventRow {
  return {
    id: r.id,
    accountId: r.accountId,
    providerEventId: r.providerEventId,
    title: r.title,
    description: r.description,
    location: r.location,
    attendees: r.attendeesJson
      ? (JSON.parse(r.attendeesJson) as CalendarAttendee[])
      : [],
    startsAt: new Date(r.startsAt).toISOString(),
    endsAt: new Date(r.endsAt).toISOString(),
    status: r.status as CalendarStatus,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function deriveDisplayName(email: string): string {
  return email.split("@")[0] ?? email;
}

async function logAttendees(
  ctx: TenantContext,
  eventId: string,
  attendees: CalendarAttendee[],
  occurredAt: number,
  title: string,
): Promise<void> {
  for (const a of attendees) {
    if (!a.email) continue;
    const contact = await findOrCreateByEmail(
      ctx,
      a.email,
      a.name ?? deriveDisplayName(a.email),
    );
    await logInteraction(ctx, {
      contactId: contact.id,
      kind: "meeting",
      referenceId: eventId,
      summary: title,
      occurredAt,
    });
  }
}

export async function listEvents(
  ctx: TenantContext,
  opts: {
    accountId?: string;
    from?: number;
    to?: number;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<PaginatedData<CalendarEventRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, calendarEvents)];
  if (opts.accountId) conditions.push(eq(calendarEvents.accountId, opts.accountId));
  if (opts.from !== undefined) conditions.push(gte(calendarEvents.startsAt, opts.from));
  if (opts.to !== undefined) conditions.push(lte(calendarEvents.startsAt, opts.to));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(calendarEvents.startsAt, cursorTs));
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(where)
    .orderBy(desc(calendarEvents.startsAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.startsAt).getTime()),
  );
}

export async function getEvent(
  ctx: TenantContext,
  id: string,
): Promise<CalendarEventRow | null> {
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(and(tenantScope(ctx, calendarEvents), eq(calendarEvents.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createEvent(
  ctx: TenantContext,
  input: CreateEventInput,
): Promise<CalendarEventRow> {
  const account = await requireConnectedAccount(ctx, input.accountId, "calendar");
  if (input.endsAt <= input.startsAt) {
    throw new Error("Event endsAt must be after startsAt");
  }
  const id = `cev_${nanoid()}`;
  const attendees = input.attendees ?? [];
  // PROVIDER STUB: real impl would POST to Google/Apple here and use
  // the returned providerEventId. For Tier 1 we synthesise one so the
  // UI flow round-trips identically.
  const providerEventId = `stub_${nanoid()}`;
  await db.insert(calendarEvents).values(
    withTenantValues(ctx, {
      id,
      accountId: input.accountId,
      providerEventId,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      attendeesJson: JSON.stringify(attendees),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: "confirmed" as const,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "comm.calendar.event_created",
    actor: "agent",
    target: `${account.provider}:${input.title}`,
    severity: "medium",
    detail: `Event scheduled ${new Date(input.startsAt).toISOString()}`,
  });
  await logAttendees(ctx, id, attendees, input.startsAt, input.title);
  const row = await getEvent(ctx, id);
  if (!row) throw new Error("Event not found after insert");
  return row;
}

export async function updateEvent(
  ctx: TenantContext,
  id: string,
  input: UpdateEventInput,
): Promise<CalendarEventRow | null> {
  const existing = await getEvent(ctx, id);
  if (!existing) return null;
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.title !== undefined) patch["title"] = input.title;
  if (input.description !== undefined) patch["description"] = input.description;
  if (input.location !== undefined) patch["location"] = input.location;
  if (input.attendees !== undefined)
    patch["attendeesJson"] = JSON.stringify(input.attendees);
  if (input.startsAt !== undefined) patch["startsAt"] = input.startsAt;
  if (input.endsAt !== undefined) patch["endsAt"] = input.endsAt;
  if (input.status !== undefined) patch["status"] = input.status;
  await db
    .update(calendarEvents)
    .set(patch)
    .where(and(tenantScope(ctx, calendarEvents), eq(calendarEvents.id, id)));
  await logPrivacyEvent(ctx, {
    eventType: "comm.calendar.event_updated",
    actor: "agent",
    target: existing.title,
    severity: "low",
  });
  return getEvent(ctx, id);
}

export async function deleteEvent(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getEvent(ctx, id);
  if (!existing) return { id, deleted: false };
  await db
    .delete(calendarEvents)
    .where(and(tenantScope(ctx, calendarEvents), eq(calendarEvents.id, id)));
  await logPrivacyEvent(ctx, {
    eventType: "comm.calendar.event_deleted",
    actor: "agent",
    target: existing.title,
    severity: "medium",
  });
  return { id, deleted: true };
}

/**
 * Find free slots in `[from, to)` of duration `durationMinutes` against the
 * busy ranges in calendar_events. Working hours bounds (`workStartHour`,
 * `workEndHour`) trim each day. Returns up to `maxResults` candidate slots
 * — the meeting-scheduling agent picks one.
 */
export async function findFreeSlots(
  ctx: TenantContext,
  opts: {
    from: number;
    to: number;
    durationMinutes: number;
    workStartHour?: number;
    workEndHour?: number;
    maxResults?: number;
    accountId?: string;
  },
): Promise<FreeSlot[]> {
  if (opts.to <= opts.from) return [];
  if (opts.durationMinutes <= 0) return [];
  const conditions = [
    tenantScope(ctx, calendarEvents),
    eq(calendarEvents.status, "confirmed"),
    gte(calendarEvents.endsAt, opts.from),
    lte(calendarEvents.startsAt, opts.to),
  ];
  if (opts.accountId) conditions.push(eq(calendarEvents.accountId, opts.accountId));
  const busy = await db
    .select()
    .from(calendarEvents)
    .where(and(...conditions))
    .orderBy(asc(calendarEvents.startsAt));

  const workStart = opts.workStartHour ?? 9;
  const workEnd = opts.workEndHour ?? 17;
  const durationMs = opts.durationMinutes * 60_000;
  const slotStepMs = 30 * 60_000; // 30-minute candidate cadence
  const maxResults = opts.maxResults ?? 10;
  const out: FreeSlot[] = [];

  function isBusy(start: number, end: number): boolean {
    for (const b of busy) {
      if (b.startsAt < end && b.endsAt > start) return true;
    }
    return false;
  }

  // Step through the window in 30-min increments. A candidate slot is
  // valid if it sits inside working hours and doesn't overlap any busy.
  for (let t = opts.from; t + durationMs <= opts.to; t += slotStepMs) {
    if (out.length >= maxResults) break;
    const startDate = new Date(t);
    const startHour = startDate.getUTCHours() + startDate.getUTCMinutes() / 60;
    const endHour = startHour + opts.durationMinutes / 60;
    if (startHour < workStart || endHour > workEnd) continue;
    if (!isBusy(t, t + durationMs)) {
      out.push({
        startsAt: new Date(t).toISOString(),
        endsAt: new Date(t + durationMs).toISOString(),
      });
    }
  }
  return out;
}
