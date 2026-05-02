/**
 * Legal compliance service (Task #25).
 *
 * Surfaces the static legal-document catalogue, records per-tenant
 * acceptance, computes pending-acceptance state for the in-app gate,
 * receives EU-AI-Act incident reports, and tracks the COPPA / GDPR-K
 * age confirmation.
 *
 * The acceptance ledger is append-only: every re-acceptance after a
 * material document update inserts a new row rather than mutating the
 * previous one. The in-app gate determines pending state by checking
 * whether the current document hash has been accepted at least once for
 * the tenant — old rows remain as proof of historic consent.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  ageConfirmations,
  buildPage,
  db,
  decodeCursor,
  incidentReports,
  legalAcceptances,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import {
  getLegalDocument,
  hashDocument,
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_TYPES,
  type LegalDocument,
  type LegalDocumentSummary,
  type LegalDocumentType,
  summariseDocument,
} from "./legal/documents";
import {
  getDefaultBundledLicences,
  getModelLicence,
  MODEL_LICENCES,
  type ModelCommercialUseVerdict,
  type ModelLicenceEntry,
} from "./legal/model-licences";

export type {
  LegalDocument,
  LegalDocumentSummary,
  LegalDocumentType,
  ModelCommercialUseVerdict,
  ModelLicenceEntry,
};

export const INCIDENT_CATEGORIES = [
  "unexpected_action",
  "approval_bypass",
  "data_egress",
  "harmful_output",
  "hallucination",
  "model_failure",
  "other",
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = [
  "submitted",
  "triaged",
  "investigating",
  "resolved",
  "closed",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const AGE_JURISDICTIONS = ["us", "eu", "uk", "global"] as const;
export type AgeJurisdiction = (typeof AGE_JURISDICTIONS)[number];

const MIN_AGE_BY_JURISDICTION: Record<AgeJurisdiction, number> = {
  us: 13,
  eu: 16,
  uk: 13,
  global: 16,
};

// ─────────────────────────────────────────────────────────────────────────
// Documents + acceptance
// ─────────────────────────────────────────────────────────────────────────

export interface AcceptanceRow {
  id: string;
  documentType: LegalDocumentType;
  documentVersion: string;
  documentHash: string;
  acceptedAt: string;
  locale: string | null;
  userAgent: string | null;
}

export interface PendingAcceptance {
  document: LegalDocumentSummary;
  lastAcceptedVersion: string | null;
  lastAcceptedAt: string | null;
}

export interface AcceptanceState {
  pending: ReadonlyArray<PendingAcceptance>;
  accepted: ReadonlyArray<AcceptanceRow>;
}

export function listLegalDocuments(): ReadonlyArray<LegalDocumentSummary> {
  return LEGAL_DOCUMENTS.map(summariseDocument);
}

export function fetchLegalDocument(
  type: LegalDocumentType,
):
  | (LegalDocumentSummary & { body: string })
  | undefined {
  const doc = getLegalDocument(type);
  if (!doc) return undefined;
  return { ...summariseDocument(doc), body: doc.body };
}

function toAcceptanceRow(
  r: typeof legalAcceptances.$inferSelect,
): AcceptanceRow {
  return {
    id: r.id,
    documentType: r.documentType as LegalDocumentType,
    documentVersion: r.documentVersion,
    documentHash: r.documentHash,
    acceptedAt: new Date(r.acceptedAt).toISOString(),
    locale: r.locale,
    userAgent: r.userAgent,
  };
}

export async function listAcceptances(
  ctx: TenantContext,
): Promise<ReadonlyArray<AcceptanceRow>> {
  const rows = await db
    .select()
    .from(legalAcceptances)
    .where(tenantScope(ctx, legalAcceptances))
    .orderBy(desc(legalAcceptances.acceptedAt))
    .limit(500);
  return rows.map(toAcceptanceRow);
}

export interface RecordAcceptanceInput {
  documentType: LegalDocumentType;
  locale?: string;
  userAgent?: string;
}

export async function recordAcceptance(
  ctx: TenantContext,
  input: RecordAcceptanceInput,
): Promise<AcceptanceRow | { error: "UNKNOWN_DOCUMENT" }> {
  const doc = getLegalDocument(input.documentType);
  if (!doc) return { error: "UNKNOWN_DOCUMENT" };
  if (!doc.requiresAcceptance) {
    // Informational documents (e.g. EU AI Act statement) do not require
    // acceptance; we still record the click as evidence the user
    // viewed the page so the audit trail is complete.
  }
  const id = `lacc_${nanoid()}`;
  const hash = hashDocument(doc);
  const now = Date.now();
  await db.insert(legalAcceptances).values(
    withTenantValues(ctx, {
      id,
      userId: ctx.userId ?? null,
      documentType: doc.type,
      documentVersion: doc.version,
      documentHash: hash,
      acceptedAt: now,
      locale: input.locale ?? null,
      userAgent: input.userAgent ?? null,
    }),
  );
  return {
    id,
    documentType: doc.type,
    documentVersion: doc.version,
    documentHash: hash,
    acceptedAt: new Date(now).toISOString(),
    locale: input.locale ?? null,
    userAgent: input.userAgent ?? null,
  };
}

export async function getAcceptanceState(
  ctx: TenantContext,
): Promise<AcceptanceState> {
  const accepted = await listAcceptances(ctx);
  // Map documentType -> latest acceptance row by acceptedAt desc.
  const latestByType = new Map<LegalDocumentType, AcceptanceRow>();
  for (const row of accepted) {
    const existing = latestByType.get(row.documentType);
    if (!existing || row.acceptedAt > existing.acceptedAt) {
      latestByType.set(row.documentType, row);
    }
  }
  const pending: PendingAcceptance[] = [];
  for (const doc of LEGAL_DOCUMENTS) {
    if (!doc.requiresAcceptance) continue;
    const summary = summariseDocument(doc);
    const last = latestByType.get(doc.type);
    if (!last || last.documentHash !== summary.hash) {
      pending.push({
        document: summary,
        lastAcceptedVersion: last ? last.documentVersion : null,
        lastAcceptedAt: last ? last.acceptedAt : null,
      });
    }
  }
  return { pending, accepted };
}

// ─────────────────────────────────────────────────────────────────────────
// Model licences
// ─────────────────────────────────────────────────────────────────────────

export function listModelLicences(): ReadonlyArray<ModelLicenceEntry> {
  return MODEL_LICENCES;
}

export function listBundledModelLicences(): ReadonlyArray<ModelLicenceEntry> {
  return getDefaultBundledLicences();
}

export function fetchModelLicence(
  modelId: string,
): ModelLicenceEntry | undefined {
  return getModelLicence(modelId);
}

// ─────────────────────────────────────────────────────────────────────────
// Incident reports
// ─────────────────────────────────────────────────────────────────────────

export interface IncidentRow {
  id: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  description: string;
  relatedRunId: string | null;
  relatedApprovalId: string | null;
  contactEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

function toIncidentRow(r: typeof incidentReports.$inferSelect): IncidentRow {
  return {
    id: r.id,
    category: r.category as IncidentCategory,
    severity: r.severity as IncidentSeverity,
    status: r.status as IncidentStatus,
    title: r.title,
    description: r.description,
    relatedRunId: r.relatedRunId,
    relatedApprovalId: r.relatedApprovalId,
    contactEmail: r.contactEmail,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export interface CreateIncidentInput {
  category: IncidentCategory;
  title: string;
  description: string;
  severity?: IncidentSeverity;
  relatedRunId?: string;
  relatedApprovalId?: string;
  contactEmail?: string;
}

export async function createIncidentReport(
  ctx: TenantContext,
  input: CreateIncidentInput,
): Promise<IncidentRow> {
  const id = `incd_${nanoid()}`;
  const now = Date.now();
  await db.insert(incidentReports).values(
    withTenantValues(ctx, {
      id,
      userId: ctx.userId ?? null,
      category: input.category,
      severity: input.severity ?? "medium",
      status: "submitted",
      title: input.title,
      description: input.description,
      relatedRunId: input.relatedRunId ?? null,
      relatedApprovalId: input.relatedApprovalId ?? null,
      contactEmail: input.contactEmail ?? null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  logger.info(
    { id, category: input.category, severity: input.severity ?? "medium" },
    "Incident report submitted",
  );
  return {
    id,
    category: input.category,
    severity: input.severity ?? "medium",
    status: "submitted",
    title: input.title,
    description: input.description,
    relatedRunId: input.relatedRunId ?? null,
    relatedApprovalId: input.relatedApprovalId ?? null,
    contactEmail: input.contactEmail ?? null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export async function listIncidentReports(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<IncidentRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor
    ? Number.parseInt(decodeCursor(opts.cursor), 10)
    : null;
  const conditions =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(
          tenantScope(ctx, incidentReports),
          lt(incidentReports.createdAt, cursorTs),
        )
      : tenantScope(ctx, incidentReports);
  const rows = await db
    .select()
    .from(incidentReports)
    .where(conditions)
    .orderBy(desc(incidentReports.createdAt), desc(incidentReports.id))
    .limit(limit + 1);
  return buildPage(
    rows.map(toIncidentRow),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Age confirmation
// ─────────────────────────────────────────────────────────────────────────

export interface AgeConfirmationRow {
  jurisdiction: AgeJurisdiction;
  minimumAge: number;
  confirmed: boolean;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toAgeRow(r: typeof ageConfirmations.$inferSelect): AgeConfirmationRow {
  return {
    jurisdiction: (r.jurisdiction as AgeJurisdiction) ?? "global",
    minimumAge: r.minimumAge,
    confirmed: r.confirmed === 1,
    confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export function minimumAgeFor(jurisdiction: AgeJurisdiction): number {
  return MIN_AGE_BY_JURISDICTION[jurisdiction];
}

export async function getAgeConfirmation(
  ctx: TenantContext,
): Promise<AgeConfirmationRow | null> {
  const rows = await db
    .select()
    .from(ageConfirmations)
    .where(tenantScope(ctx, ageConfirmations))
    .limit(1);
  return rows[0] ? toAgeRow(rows[0]) : null;
}

export interface UpsertAgeConfirmationInput {
  jurisdiction: AgeJurisdiction;
  confirmed: boolean;
}

export async function upsertAgeConfirmation(
  ctx: TenantContext,
  input: UpsertAgeConfirmationInput,
): Promise<AgeConfirmationRow> {
  const minimumAge = MIN_AGE_BY_JURISDICTION[input.jurisdiction];
  const row = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(ageConfirmations)
      .where(tenantScope(ctx, ageConfirmations))
      .limit(1)
      .all();
    const now = Date.now();
    if (existing.length === 0) {
      tx.insert(ageConfirmations)
        .values(
          withTenantValues(ctx, {
            id: `age_${nanoid()}`,
            userId: ctx.userId ?? null,
            jurisdiction: input.jurisdiction,
            minimumAge,
            confirmed: input.confirmed ? 1 : 0,
            confirmedAt: input.confirmed ? now : null,
            createdAt: now,
            updatedAt: now,
            version: 1,
          }),
        )
        .run();
    } else {
      const prev = existing[0];
      if (!prev) throw new Error("age confirmation race: row vanished");
      const confirmed = prev.confirmed === 1 || input.confirmed;
      tx.update(ageConfirmations)
        .set({
          jurisdiction: input.jurisdiction,
          minimumAge,
          confirmed: confirmed ? 1 : 0,
          confirmedAt: confirmed
            ? prev.confirmedAt ?? now
            : null,
          updatedAt: now,
          version: prev.version + 1,
        })
        .where(
          and(
            tenantScope(ctx, ageConfirmations),
            eq(ageConfirmations.id, prev.id),
          ),
        )
        .run();
    }
    const after = tx
      .select()
      .from(ageConfirmations)
      .where(tenantScope(ctx, ageConfirmations))
      .limit(1)
      .all();
    if (!after[0]) throw new Error("age confirmation not found after upsert");
    return toAgeRow(after[0]);
  });
  return Promise.resolve(row);
}

// Re-export catalogue constants used by route validation.
export { LEGAL_DOCUMENT_TYPES };
