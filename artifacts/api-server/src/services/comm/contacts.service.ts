/**
 * Contacts service — local CRM record store.
 *
 * Contacts are looked up by email or phone; if no match exists the
 * `findOrCreateBy*` helpers create a row on the fly. This is how the
 * email/voip/calendar services keep the CRM in sync without each call site
 * needing to know the lookup rules.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  contacts,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

export interface ContactRow {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  lastInteractionAt: string | null;
  followUpAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactInput {
  displayName: string;
  email?: string;
  phone?: string;
  company?: string;
  notes?: string;
  followUpAt?: number;
}

export interface UpdateContactInput {
  displayName?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  notes?: string | null;
  followUpAt?: number | null;
}

function toRow(r: typeof contacts.$inferSelect): ContactRow {
  return {
    id: r.id,
    displayName: r.displayName,
    email: r.email,
    phone: r.phone,
    company: r.company,
    notes: r.notes,
    lastInteractionAt: r.lastInteractionAt
      ? new Date(r.lastInteractionAt).toISOString()
      : null,
    followUpAt: r.followUpAt ? new Date(r.followUpAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listContacts(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<ContactRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, contacts);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(contacts.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(contacts)
    .where(where)
    .orderBy(desc(contacts.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getContact(
  ctx: TenantContext,
  id: string,
): Promise<ContactRow | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(tenantScope(ctx, contacts), eq(contacts.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function createContact(
  ctx: TenantContext,
  input: CreateContactInput,
): Promise<ContactRow> {
  const id = `con_${nanoid()}`;
  await db.insert(contacts).values(
    withTenantValues(ctx, {
      id,
      displayName: input.displayName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      company: input.company ?? null,
      notes: input.notes ?? null,
      followUpAt: input.followUpAt ?? null,
    }),
  );
  const row = await getContact(ctx, id);
  if (!row) throw new Error("Contact not found after insert");
  return row;
}

export async function updateContact(
  ctx: TenantContext,
  id: string,
  input: UpdateContactInput,
): Promise<ContactRow | null> {
  const existing = await getContact(ctx, id);
  if (!existing) return null;
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.displayName !== undefined) patch["displayName"] = input.displayName;
  if (input.email !== undefined) patch["email"] = input.email;
  if (input.phone !== undefined) patch["phone"] = input.phone;
  if (input.company !== undefined) patch["company"] = input.company;
  if (input.notes !== undefined) patch["notes"] = input.notes;
  if (input.followUpAt !== undefined) patch["followUpAt"] = input.followUpAt;
  await db
    .update(contacts)
    .set(patch)
    .where(and(tenantScope(ctx, contacts), eq(contacts.id, id)));
  return getContact(ctx, id);
}

export async function deleteContact(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getContact(ctx, id);
  if (!existing) return { id, deleted: false };
  await db.delete(contacts).where(and(tenantScope(ctx, contacts), eq(contacts.id, id)));
  return { id, deleted: true };
}

/**
 * Lookup-or-create by email. Used by the email service when a new sender
 * appears in the inbox so the CRM stays in sync without any explicit
 * "import contacts" step.
 */
export async function findOrCreateByEmail(
  ctx: TenantContext,
  email: string,
  displayName: string,
): Promise<ContactRow> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(tenantScope(ctx, contacts), eq(contacts.email, email)))
    .limit(1);
  if (rows[0]) return toRow(rows[0]);
  return createContact(ctx, { displayName, email });
}

export async function findOrCreateByPhone(
  ctx: TenantContext,
  phone: string,
  displayName: string,
): Promise<ContactRow> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(tenantScope(ctx, contacts), eq(contacts.phone, phone)))
    .limit(1);
  if (rows[0]) return toRow(rows[0]);
  return createContact(ctx, { displayName, phone });
}

/** Bump `lastInteractionAt` after a touch in any channel. */
export async function touchContact(
  ctx: TenantContext,
  id: string,
  ts: number,
): Promise<void> {
  await db
    .update(contacts)
    .set({ lastInteractionAt: ts, updatedAt: Date.now() })
    .where(and(tenantScope(ctx, contacts), eq(contacts.id, id)));
}
