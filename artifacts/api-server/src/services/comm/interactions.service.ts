/**
 * Interactions service — append-only contact history log.
 *
 * Every email/call/meeting touchpoint adds a row here so the CRM can
 * answer "what did I last discuss with X?" without scanning the
 * per-channel tables. Logging also bumps the contact's
 * `lastInteractionAt` so the contacts list sorts by recency.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  interactions,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { touchContact } from "./contacts.service";

export type InteractionKind =
  | "email_in"
  | "email_out"
  | "call_in"
  | "call_out"
  | "meeting";

export interface InteractionRow {
  id: string;
  contactId: string;
  kind: InteractionKind;
  referenceId: string | null;
  summary: string;
  occurredAt: string;
  createdAt: string;
}

export interface LogInteractionInput {
  contactId: string;
  kind: InteractionKind;
  referenceId?: string;
  summary: string;
  occurredAt?: number;
}

function toRow(r: typeof interactions.$inferSelect): InteractionRow {
  return {
    id: r.id,
    contactId: r.contactId,
    kind: r.kind as InteractionKind,
    referenceId: r.referenceId,
    summary: r.summary,
    occurredAt: new Date(r.occurredAt).toISOString(),
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function logInteraction(
  ctx: TenantContext,
  input: LogInteractionInput,
): Promise<InteractionRow> {
  const id = `int_${nanoid()}`;
  const occurredAt = input.occurredAt ?? Date.now();
  await db.insert(interactions).values(
    withTenantValues(ctx, {
      id,
      contactId: input.contactId,
      kind: input.kind,
      referenceId: input.referenceId ?? null,
      summary: input.summary,
      occurredAt,
    }),
  );
  // Keep the contact's "last touched" stamp in step so contact lists
  // can sort by recency without joining the interactions table.
  await touchContact(ctx, input.contactId, occurredAt);
  const row = await getInteraction(ctx, id);
  if (!row) throw new Error("Interaction not found after insert");
  return row;
}

export async function getInteraction(
  ctx: TenantContext,
  id: string,
): Promise<InteractionRow | null> {
  const rows = await db
    .select()
    .from(interactions)
    .where(and(tenantScope(ctx, interactions), eq(interactions.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listInteractions(
  ctx: TenantContext,
  opts: { contactId?: string; cursor?: string; limit?: number } = {},
): Promise<PaginatedData<InteractionRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, interactions);
  const conditions = [baseScope];
  if (opts.contactId) conditions.push(eq(interactions.contactId, opts.contactId));
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(interactions.occurredAt, cursorTs));
  }
  const where = conditions.length === 1 ? baseScope : and(...conditions);
  const rows = await db
    .select()
    .from(interactions)
    .where(where)
    .orderBy(desc(interactions.occurredAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.occurredAt).getTime()),
  );
}
