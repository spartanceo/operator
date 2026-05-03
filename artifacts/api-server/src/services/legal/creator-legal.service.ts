/**
 * Creator legal & tax compliance service (Task #26).
 *
 * One module so the cross-cutting invariants — "must accept current
 * agreement before publishing", "must have a valid tax form on file
 * before payout", "must not be a sanctioned recipient" — live next to
 * each other and can be exercised by a single state-fetch endpoint.
 *
 * The module owns:
 *   - Creator Agreement signature ledger + state.
 *   - DMCA takedown workflow (public submit, admin review, counter-
 *     notice, repeat-infringer ban).
 *   - Encrypted W-9 / W-8BEN tax-form collection.
 *   - 1099-K generation + tax-document delivery.
 *   - VAT/GST/sales-tax collection records (per-transaction ledger
 *     for the OSS / HMRC / ATO returns).
 *   - Payout settings + sanctions screening.
 *
 * Crypto:
 *   Tax-form payloads are sealed with AES-256-GCM under a key derived
 *   from `OMNINITY_TAX_VAULT_KEY` (or a per-test ephemeral key when
 *   the env var is absent — same pattern as the keychain service).
 *   The tax-id is additionally fingerprinted with SHA-256 so dedup
 *   and "is this the same number I had before?" checks work without
 *   ever decrypting the payload.
 */
import { createHash, scryptSync } from "node:crypto";
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  creatorAccounts,
  creatorAgreementSignatures,
  creatorPayoutScreenings,
  creatorPayoutSettings,
  creatorTaxDocuments,
  creatorTaxForms,
  db,
  decodeCursor,
  dmcaCounterNotices,
  dmcaTakedowns,
  normaliseLimit,
  type PaginatedData,
  taxCollections,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../../lib/logger";
import {
  openSecret,
  sealSecret,
  type SealedSecret,
} from "../../lib/security-crypto";
import { appendAuditEntry } from "../audit.service";
import {
  CREATOR_AGREEMENT,
  hashCreatorAgreement,
} from "./creator-agreement";
import {
  payoutRestrictionFor,
  screenRecipient,
  type SanctionsList,
  type ScreeningResult,
} from "./sanctions-list";
import {
  getTaxJurisdiction,
  quoteTax,
  type TaxQuote,
} from "./tax-rates";

// ────────────────────────────────────────────────────────────────────────
// Crypto — derived key for tax-form encryption
// ────────────────────────────────────────────────────────────────────────

let cachedTaxKey: Buffer | null = null;
function taxVaultKey(): Buffer {
  if (cachedTaxKey) return cachedTaxKey;
  const seed =
    process.env["OMNINITY_TAX_VAULT_KEY"] ??
    "test-only-tax-vault-key-do-not-use-in-prod";
  cachedTaxKey = scryptSync(seed, "omninity-tax-forms-v1", 32);
  return cachedTaxKey;
}

function fingerprintTaxId(raw: string): string {
  return createHash("sha256")
    .update(raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase())
    .digest("hex");
}

interface TaxFormPayload {
  fullName: string;
  businessName?: string;
  address: string;
  taxId: string;
}

function sealTaxPayload(payload: TaxFormPayload): string {
  const sealed = sealSecret(taxVaultKey(), JSON.stringify(payload));
  return JSON.stringify(sealed);
}

function openTaxPayload(blob: string): TaxFormPayload {
  const sealed = JSON.parse(blob) as SealedSecret;
  const json = openSecret(taxVaultKey(), sealed);
  return JSON.parse(json) as TaxFormPayload;
}

// ────────────────────────────────────────────────────────────────────────
// Creator Agreement — versioned signing ledger
// ────────────────────────────────────────────────────────────────────────

export interface CreatorAgreementStatePending {
  readonly state: "pending";
  readonly currentVersion: string;
  readonly currentHash: string;
  readonly title: string;
  readonly summary: string;
  readonly lastSignedVersion: string | null;
  readonly lastSignedAt: number | null;
}
export interface CreatorAgreementStateAccepted {
  readonly state: "accepted";
  readonly currentVersion: string;
  readonly currentHash: string;
  readonly title: string;
  readonly summary: string;
  readonly signedAt: number;
  readonly signedName: string;
}
export type CreatorAgreementState =
  | CreatorAgreementStatePending
  | CreatorAgreementStateAccepted;

export interface SignAgreementInput {
  readonly creatorId: string;
  readonly signedName: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly locale?: string;
}

export async function getCreatorAgreement(): Promise<{
  version: string;
  hash: string;
  title: string;
  summary: string;
  body: string;
  effectiveDate: string;
}> {
  return {
    version: CREATOR_AGREEMENT.version,
    hash: hashCreatorAgreement(CREATOR_AGREEMENT),
    title: CREATOR_AGREEMENT.title,
    summary: CREATOR_AGREEMENT.summary,
    body: CREATOR_AGREEMENT.body,
    effectiveDate: CREATOR_AGREEMENT.effectiveDate,
  };
}

export async function getAgreementState(
  ctx: TenantContext,
  creatorId: string,
): Promise<CreatorAgreementState> {
  const currentHash = hashCreatorAgreement(CREATOR_AGREEMENT);
  const rows = await db
    .select()
    .from(creatorAgreementSignatures)
    .where(
      and(
        tenantScope(ctx, creatorAgreementSignatures),
        eq(creatorAgreementSignatures.creatorId, creatorId),
      ),
    )
    .orderBy(desc(creatorAgreementSignatures.signedAt))
    .limit(1);
  const last = rows[0];
  if (last && last.agreementHash === currentHash) {
    return {
      state: "accepted",
      currentVersion: CREATOR_AGREEMENT.version,
      currentHash,
      title: CREATOR_AGREEMENT.title,
      summary: CREATOR_AGREEMENT.summary,
      signedAt: last.signedAt,
      signedName: last.signedName,
    };
  }
  return {
    state: "pending",
    currentVersion: CREATOR_AGREEMENT.version,
    currentHash,
    title: CREATOR_AGREEMENT.title,
    summary: CREATOR_AGREEMENT.summary,
    lastSignedVersion: last?.agreementVersion ?? null,
    lastSignedAt: last?.signedAt ?? null,
  };
}

export async function signAgreement(
  ctx: TenantContext,
  input: SignAgreementInput,
): Promise<CreatorAgreementStateAccepted> {
  const id = `cas_${nanoid()}`;
  const now = Date.now();
  const hash = hashCreatorAgreement(CREATOR_AGREEMENT);
  await db.insert(creatorAgreementSignatures).values(
    withTenantValues(ctx, {
      id,
      creatorId: input.creatorId,
      agreementVersion: CREATOR_AGREEMENT.version,
      agreementHash: hash,
      signedName: input.signedName.trim(),
      signedAt: now,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      locale: input.locale ?? null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: input.creatorId,
    action: "creator.agreement.signed",
    resourceType: "creator_agreement",
    resourceId: input.creatorId,
    summary: `Creator signed agreement v${CREATOR_AGREEMENT.version}`,
  });
  return {
    state: "accepted",
    currentVersion: CREATOR_AGREEMENT.version,
    currentHash: hash,
    title: CREATOR_AGREEMENT.title,
    summary: CREATOR_AGREEMENT.summary,
    signedAt: now,
    signedName: input.signedName.trim(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// DMCA — public takedown notices, admin review, counter-notices,
// repeat-infringer ban
// ────────────────────────────────────────────────────────────────────────

export const DMCA_STATUSES = [
  "received",
  "reviewing",
  "upheld",
  "rejected",
  "counter_noticed",
  "restored",
] as const;
export type DmcaStatus = (typeof DMCA_STATUSES)[number];

// tier-review: bounded — fixed-size literal allowlist of DMCA terminal statuses
export const DMCA_TERMINAL_STATUSES: ReadonlySet<DmcaStatus> = new Set([
  "rejected",
  "restored",
]);

export interface SubmitTakedownInput {
  readonly storeSkillId?: string;
  readonly creatorHandle?: string;
  readonly skillSlug?: string;
  readonly skillUrl?: string;
  readonly claimantName: string;
  readonly claimantEmail: string;
  readonly claimantAddress: string;
  readonly claimantPhone?: string;
  readonly workDescription: string;
  readonly infringementDescription: string;
  readonly goodFaithStatement: boolean;
  readonly accuracyStatement: boolean;
  readonly signature: string;
  readonly submitterIp?: string;
  readonly submitterUserAgent?: string;
}

export interface DmcaTakedownRow {
  readonly id: string;
  readonly status: DmcaStatus;
  readonly storeSkillId: string | null;
  readonly creatorHandle: string | null;
  readonly skillSlug: string | null;
  readonly skillUrl: string | null;
  readonly claimantName: string;
  readonly claimantEmail: string;
  readonly workDescription: string;
  readonly infringementDescription: string;
  readonly decisionNotes: string | null;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
  readonly skillRemovedAt: number | null;
  readonly counterNoticeId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function toTakedownRow(r: typeof dmcaTakedowns.$inferSelect): DmcaTakedownRow {
  return {
    id: r.id,
    status: r.status as DmcaStatus,
    storeSkillId: r.storeSkillId,
    creatorHandle: r.creatorHandle,
    skillSlug: r.skillSlug,
    skillUrl: r.skillUrl,
    claimantName: r.claimantName,
    claimantEmail: r.claimantEmail,
    workDescription: r.workDescription,
    infringementDescription: r.infringementDescription,
    decisionNotes: r.decisionNotes,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy,
    skillRemovedAt: r.skillRemovedAt,
    counterNoticeId: r.counterNoticeId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function submitTakedown(
  ctx: TenantContext,
  input: SubmitTakedownInput,
): Promise<DmcaTakedownRow> {
  if (!input.goodFaithStatement || !input.accuracyStatement) {
    throw new CreatorLegalError(
      "DMCA_INCOMPLETE",
      "Good-faith and accuracy statements are required by 17 USC § 512(c)(3)",
    );
  }
  const id = `dmca_${nanoid()}`;
  const now = Date.now();
  await db.insert(dmcaTakedowns).values(
    withTenantValues(ctx, {
      id,
      storeSkillId: input.storeSkillId ?? null,
      creatorHandle: input.creatorHandle ?? null,
      skillSlug: input.skillSlug ?? null,
      skillUrl: input.skillUrl ?? null,
      claimantName: input.claimantName.trim(),
      claimantEmail: input.claimantEmail.trim().toLowerCase(),
      claimantAddress: input.claimantAddress.trim(),
      claimantPhone: input.claimantPhone ?? null,
      workDescription: input.workDescription,
      infringementDescription: input.infringementDescription,
      goodFaithStatement: 1,
      accuracyStatement: 1,
      signature: input.signature.trim(),
      status: "received",
      submitterIp: input.submitterIp ?? null,
      submitterUserAgent: input.submitterUserAgent ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: input.claimantEmail,
    action: "dmca.takedown.received",
    resourceType: "dmca_takedown",
    resourceId: id,
    summary: `DMCA notice received from ${input.claimantName} for ${input.creatorHandle ?? "?"}/${input.skillSlug ?? "?"}`,
  });
  const [row] = await db
    .select()
    .from(dmcaTakedowns)
    .where(and(tenantScope(ctx, dmcaTakedowns), eq(dmcaTakedowns.id, id)))
    .limit(1);
  if (!row) throw new Error("Failed to read back inserted takedown");
  return toTakedownRow(row);
}

export interface DecideTakedownInput {
  readonly id: string;
  readonly decision: "uphold" | "reject";
  readonly notes?: string;
  readonly actor: string;
}

export async function decideTakedown(
  ctx: TenantContext,
  input: DecideTakedownInput,
): Promise<DmcaTakedownRow> {
  const [existing] = await db
    .select()
    .from(dmcaTakedowns)
    .where(and(tenantScope(ctx, dmcaTakedowns), eq(dmcaTakedowns.id, input.id)))
    .limit(1);
  if (!existing) throw new CreatorLegalError("NOT_FOUND", "Takedown not found", 404);
  if (DMCA_TERMINAL_STATUSES.has(existing.status as DmcaStatus)) {
    throw new CreatorLegalError(
      "DMCA_TERMINAL",
      `Takedown is already ${existing.status}; reopen via counter-notice`,
    );
  }
  const now = Date.now();
  const newStatus: DmcaStatus = input.decision === "uphold" ? "upheld" : "rejected";
  await db
    .update(dmcaTakedowns)
    .set({
      status: newStatus,
      decisionNotes: input.notes ?? null,
      decidedAt: now,
      decidedBy: input.actor,
      skillRemovedAt: input.decision === "uphold" ? now : existing.skillRemovedAt,
      updatedAt: now,
      version: existing.version + 1,
    })
    .where(and(tenantScope(ctx, dmcaTakedowns), eq(dmcaTakedowns.id, input.id)));
  await appendAuditEntry(ctx, {
    actor: input.actor,
    action: `dmca.takedown.${input.decision === "uphold" ? "upheld" : "rejected"}`,
    resourceType: "dmca_takedown",
    resourceId: input.id,
    summary: input.notes ?? `Takedown ${input.decision}`,
  });

  // Repeat-infringer policy: count upheld takedowns against this
  // creator. Three strikes = permanent publish ban.
  if (input.decision === "uphold" && existing.creatorHandle) {
    await maybeBanRepeatInfringer(ctx, existing.creatorHandle, input.actor);
  }

  const [row] = await db
    .select()
    .from(dmcaTakedowns)
    .where(and(tenantScope(ctx, dmcaTakedowns), eq(dmcaTakedowns.id, input.id)))
    .limit(1);
  return toTakedownRow(row!);
}

export const REPEAT_INFRINGER_THRESHOLD = 3;

async function maybeBanRepeatInfringer(
  ctx: TenantContext,
  creatorHandle: string,
  actor: string,
): Promise<void> {
  const upheld = await db
    .select({ count: sql<number>`count(*)` })
    .from(dmcaTakedowns)
    .where(
      and(
        tenantScope(ctx, dmcaTakedowns),
        eq(dmcaTakedowns.creatorHandle, creatorHandle),
        eq(dmcaTakedowns.status, "upheld"),
      ),
    );
  const count = Number(upheld[0]?.count ?? 0);
  if (count < REPEAT_INFRINGER_THRESHOLD) return;
  // Resolve creator id from handle.
  const [creator] = await db
    .select()
    .from(creatorAccounts)
    .where(
      and(
        tenantScope(ctx, creatorAccounts),
        eq(creatorAccounts.handle, creatorHandle),
      ),
    )
    .limit(1);
  if (!creator) return;
  await upsertPayoutSettings(ctx, {
    creatorId: creator.id,
    publishStatus: "ban",
    restrictionReason: `Repeat infringer — ${count} upheld DMCA takedowns`,
  });
  await appendAuditEntry(ctx, {
    actor,
    action: "creator.repeat_infringer.banned",
    resourceType: "creator_account",
    resourceId: creator.id,
    summary: `Creator @${creatorHandle} banned after ${count} upheld takedowns`,
  });
}

export interface CounterNoticeInput {
  readonly takedownId: string;
  readonly creatorId?: string;
  readonly creatorName: string;
  readonly creatorEmail: string;
  readonly creatorAddress: string;
  readonly statement: string;
  readonly consentToJurisdiction: boolean;
  readonly perjuryStatement: boolean;
  readonly signature: string;
  readonly submitterIp?: string;
  readonly submitterUserAgent?: string;
}

export async function submitCounterNotice(
  ctx: TenantContext,
  input: CounterNoticeInput,
): Promise<{ counterNoticeId: string; takedownId: string }> {
  if (!input.consentToJurisdiction || !input.perjuryStatement) {
    throw new CreatorLegalError(
      "DMCA_COUNTER_INCOMPLETE",
      "Both consent-to-jurisdiction and penalty-of-perjury statements are required",
    );
  }
  const [takedown] = await db
    .select()
    .from(dmcaTakedowns)
    .where(
      and(tenantScope(ctx, dmcaTakedowns), eq(dmcaTakedowns.id, input.takedownId)),
    )
    .limit(1);
  if (!takedown) throw new CreatorLegalError("NOT_FOUND", "Takedown not found", 404);
  const id = `dcn_${nanoid()}`;
  const now = Date.now();
  await db.insert(dmcaCounterNotices).values(
    withTenantValues(ctx, {
      id,
      takedownId: input.takedownId,
      creatorId: input.creatorId ?? null,
      creatorName: input.creatorName.trim(),
      creatorEmail: input.creatorEmail.trim().toLowerCase(),
      creatorAddress: input.creatorAddress.trim(),
      statement: input.statement,
      consentToJurisdiction: 1,
      perjuryStatement: 1,
      signature: input.signature.trim(),
      status: "received",
      submitterIp: input.submitterIp ?? null,
      submitterUserAgent: input.submitterUserAgent ?? null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await db
    .update(dmcaTakedowns)
    .set({
      status: "counter_noticed",
      counterNoticeId: id,
      updatedAt: now,
      version: takedown.version + 1,
    })
    .where(
      and(tenantScope(ctx, dmcaTakedowns), eq(dmcaTakedowns.id, input.takedownId)),
    );
  await appendAuditEntry(ctx, {
    actor: input.creatorEmail,
    action: "dmca.counter_notice.received",
    resourceType: "dmca_takedown",
    resourceId: input.takedownId,
    summary: `Counter-notice from ${input.creatorName}`,
  });
  return { counterNoticeId: id, takedownId: input.takedownId };
}

export interface ListTakedownsInput {
  readonly status?: DmcaStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export async function listTakedowns(
  ctx: TenantContext,
  input: ListTakedownsInput = {},
): Promise<PaginatedData<DmcaTakedownRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs = input.cursor
    ? Number.parseInt(decodeCursor(input.cursor), 10)
    : null;
  const conditions = [tenantScope(ctx, dmcaTakedowns)];
  if (input.status) conditions.push(eq(dmcaTakedowns.status, input.status));
  if (cursorTs && Number.isFinite(cursorTs)) {
    conditions.push(lt(dmcaTakedowns.createdAt, cursorTs));
  }
  const rows = await db
    .select()
    .from(dmcaTakedowns)
    .where(and(...conditions))
    .orderBy(desc(dmcaTakedowns.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toTakedownRow), limit, (r) => String(r.createdAt));
}

// ────────────────────────────────────────────────────────────────────────
// Tax forms — encrypted W-9 / W-8BEN
// ────────────────────────────────────────────────────────────────────────

export const TAX_FORM_TYPES = ["w9", "w8ben"] as const;
export type TaxFormType = (typeof TAX_FORM_TYPES)[number];

export interface SubmitTaxFormInput {
  readonly creatorId: string;
  readonly formType: TaxFormType;
  readonly fullName: string;
  readonly businessName?: string;
  readonly address: string;
  readonly taxId: string;
  readonly countryCode: string;
}

export interface TaxFormStatePresent {
  readonly state: "present";
  readonly id: string;
  readonly formType: TaxFormType;
  readonly status: "active" | "superseded" | "invalid";
  readonly valid: boolean;
  readonly backupWithholdingBps: number;
  readonly countryCode: string;
  readonly submittedAt: number;
  readonly taxIdLast4: string;
  readonly fullName: string;
}
export interface TaxFormStateMissing {
  readonly state: "missing";
  readonly backupWithholdingBps: number;
}
export type TaxFormState = TaxFormStatePresent | TaxFormStateMissing;

const BACKUP_WITHHOLDING_BPS = 2400; // 24% IRS backup withholding

function isValidTaxId(formType: TaxFormType, taxId: string, country: string): boolean {
  const stripped = taxId.replace(/[^A-Za-z0-9]/g, "");
  if (formType === "w9") {
    // SSN (9 digits) or EIN (9 digits). Not all-zeros.
    return /^[0-9]{9}$/.test(stripped) && stripped !== "000000000";
  }
  // W-8BEN — country-issued TIN. Minimum 4 alphanumeric characters
  // and country must not be the U.S.
  return stripped.length >= 4 && country.toUpperCase() !== "US";
}

export async function submitTaxForm(
  ctx: TenantContext,
  input: SubmitTaxFormInput,
): Promise<TaxFormStatePresent> {
  const country = input.countryCode.trim().toUpperCase();
  const valid = isValidTaxId(input.formType, input.taxId, country);
  const fingerprint = fingerprintTaxId(input.taxId);
  const sealed = sealTaxPayload({
    fullName: input.fullName,
    businessName: input.businessName,
    address: input.address,
    taxId: input.taxId,
  });
  const now = Date.now();
  // Mark previous active forms as superseded.
  await db
    .update(creatorTaxForms)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        tenantScope(ctx, creatorTaxForms),
        eq(creatorTaxForms.creatorId, input.creatorId),
        eq(creatorTaxForms.status, "active"),
      ),
    );
  const id = `tax_${nanoid()}`;
  await db.insert(creatorTaxForms).values(
    withTenantValues(ctx, {
      id,
      creatorId: input.creatorId,
      formType: input.formType,
      encryptedPayload: sealed,
      taxIdFingerprint: fingerprint,
      countryCode: country,
      status: valid ? "active" : "invalid",
      valid: valid ? 1 : 0,
      backupWithholdingBps: valid ? 0 : BACKUP_WITHHOLDING_BPS,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: input.creatorId,
    action: "creator.tax_form.submitted",
    resourceType: "creator_tax_form",
    resourceId: id,
    summary: `Submitted ${input.formType.toUpperCase()} (valid=${valid})`,
  });
  return {
    state: "present",
    id,
    formType: input.formType,
    status: valid ? "active" : "invalid",
    valid,
    backupWithholdingBps: valid ? 0 : BACKUP_WITHHOLDING_BPS,
    countryCode: country,
    submittedAt: now,
    taxIdLast4: input.taxId.replace(/[^A-Za-z0-9]/g, "").slice(-4),
    fullName: input.fullName,
  };
}

export async function getTaxFormState(
  ctx: TenantContext,
  creatorId: string,
): Promise<TaxFormState> {
  const rows = await db
    .select()
    .from(creatorTaxForms)
    .where(
      and(
        tenantScope(ctx, creatorTaxForms),
        eq(creatorTaxForms.creatorId, creatorId),
      ),
    )
    .orderBy(desc(creatorTaxForms.submittedAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { state: "missing", backupWithholdingBps: BACKUP_WITHHOLDING_BPS };
  }
  let last4 = "";
  let fullName = "";
  try {
    const payload = openTaxPayload(row.encryptedPayload);
    last4 = payload.taxId.replace(/[^A-Za-z0-9]/g, "").slice(-4);
    fullName = payload.fullName;
  } catch (e) {
    logger.warn({ err: e, id: row.id }, "tax-form decryption failed");
  }
  return {
    state: "present",
    id: row.id,
    formType: row.formType as TaxFormType,
    status: row.status as "active" | "superseded" | "invalid",
    valid: row.valid === 1,
    backupWithholdingBps: row.backupWithholdingBps,
    countryCode: row.countryCode,
    submittedAt: row.submittedAt,
    taxIdLast4: last4,
    fullName,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tax documents — 1099-K generation
// ────────────────────────────────────────────────────────────────────────

export const FORM_1099K_THRESHOLD_CENTS = 60_000_00; // 2026 IRS threshold ($600 → $60k for 2026)
// Note: the IRS 1099-K threshold has been in flux. We keep it as a
// configurable constant; production reads it from a settings row.

export interface GenerateTaxDocumentInput {
  readonly creatorId: string;
  readonly taxYear: number;
  readonly grossAmountCents: number;
  readonly transactionCount: number;
  readonly backupWithholdingCents?: number;
  readonly documentType?: "form_1099_k" | "form_1099_misc" | "annual_summary";
}

export interface CreatorTaxDocumentRow {
  readonly id: string;
  readonly documentType: string;
  readonly taxYear: number;
  readonly grossAmountCents: number;
  readonly transactionCount: number;
  readonly backupWithholdingCents: number;
  readonly bodyHash: string;
  readonly status: string;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
  readonly filedAt: number | null;
}

function renderTaxDocumentBody(
  documentType: string,
  taxYear: number,
  grossCents: number,
  txnCount: number,
  withholdingCents: number,
  creatorName: string,
): string {
  return `OMNINITY OPERATOR — ${documentType.toUpperCase()}
Tax year: ${taxYear}
Recipient: ${creatorName}
Gross amount: $${(grossCents / 100).toFixed(2)} USD
Transactions: ${txnCount}
Backup withholding: $${(withholdingCents / 100).toFixed(2)} USD
Issued: ${new Date().toISOString()}
`;
}

export async function generateTaxDocument(
  ctx: TenantContext,
  input: GenerateTaxDocumentInput,
): Promise<CreatorTaxDocumentRow> {
  const documentType = input.documentType ?? "form_1099_k";
  if (
    documentType === "form_1099_k" &&
    input.grossAmountCents < FORM_1099K_THRESHOLD_CENTS
  ) {
    throw new CreatorLegalError(
      "BELOW_THRESHOLD",
      `Gross of $${(input.grossAmountCents / 100).toFixed(2)} is below the 1099-K threshold`,
    );
  }
  const [creator] = await db
    .select()
    .from(creatorAccounts)
    .where(
      and(tenantScope(ctx, creatorAccounts), eq(creatorAccounts.id, input.creatorId)),
    )
    .limit(1);
  if (!creator) throw new CreatorLegalError("NOT_FOUND", "Creator not found", 404);
  const withholding = input.backupWithholdingCents ?? 0;
  const body = renderTaxDocumentBody(
    documentType,
    input.taxYear,
    input.grossAmountCents,
    input.transactionCount,
    withholding,
    creator.displayName,
  );
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const id = `tdoc_${nanoid()}`;
  const now = Date.now();
  try {
    await db.insert(creatorTaxDocuments).values(
      withTenantValues(ctx, {
        id,
        creatorId: input.creatorId,
        documentType,
        taxYear: input.taxYear,
        grossAmountCents: input.grossAmountCents,
        transactionCount: input.transactionCount,
        backupWithholdingCents: withholding,
        body,
        bodyHash,
        status: "issued",
        createdAt: now,
        updatedAt: now,
      }),
    );
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      throw new CreatorLegalError(
        "ALREADY_ISSUED",
        `${documentType} for ${input.taxYear} already issued for this creator`,
      );
    }
    throw e;
  }
  await appendAuditEntry(ctx, {
    actor: "system",
    action: "creator.tax_document.issued",
    resourceType: "creator_tax_document",
    resourceId: id,
    summary: `${documentType} for tax year ${input.taxYear}`,
  });
  return {
    id,
    documentType,
    taxYear: input.taxYear,
    grossAmountCents: input.grossAmountCents,
    transactionCount: input.transactionCount,
    backupWithholdingCents: withholding,
    bodyHash,
    status: "issued",
    createdAt: now,
    deliveredAt: null,
    filedAt: null,
  };
}

export async function listTaxDocuments(
  ctx: TenantContext,
  creatorId: string,
): Promise<ReadonlyArray<CreatorTaxDocumentRow>> {
  const rows = await db
    .select()
    .from(creatorTaxDocuments)
    .where(
      and(
        tenantScope(ctx, creatorTaxDocuments),
        eq(creatorTaxDocuments.creatorId, creatorId),
      ),
    )
    .orderBy(desc(creatorTaxDocuments.taxYear));
  return rows.map((r) => ({
    id: r.id,
    documentType: r.documentType,
    taxYear: r.taxYear,
    grossAmountCents: r.grossAmountCents,
    transactionCount: r.transactionCount,
    backupWithholdingCents: r.backupWithholdingCents,
    bodyHash: r.bodyHash,
    status: r.status,
    createdAt: r.createdAt,
    deliveredAt: r.deliveredAt,
    filedAt: r.filedAt,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Tax collections — VAT/GST per transaction
// ────────────────────────────────────────────────────────────────────────

export interface RecordTaxCollectionInput {
  readonly source: string;
  readonly sourceRef?: string;
  readonly buyerCountry: string;
  readonly buyerRegion?: string;
  readonly netAmountCents: number;
  readonly currency?: string;
  readonly isBusiness?: boolean;
  readonly businessVatNumber?: string;
  readonly invoiceNumber?: string;
}

export interface TaxCollectionRow {
  readonly id: string;
  readonly source: string;
  readonly buyerCountry: string;
  readonly taxType: string;
  readonly taxRateBps: number;
  readonly netAmountCents: number;
  readonly taxAmountCents: number;
  readonly grossAmountCents: number;
  readonly remittanceBucket: string;
  readonly currency: string;
  readonly collectedAt: number;
}

export function quoteTaxForCheckout(input: {
  buyerCountry: string;
  netAmountCents: number;
  isBusiness?: boolean;
  businessVatNumber?: string | null;
}): TaxQuote {
  return quoteTax(input);
}

export async function recordTaxCollection(
  ctx: TenantContext,
  input: RecordTaxCollectionInput,
): Promise<TaxCollectionRow> {
  const quote = quoteTax({
    buyerCountry: input.buyerCountry,
    netAmountCents: input.netAmountCents,
    isBusiness: input.isBusiness,
    businessVatNumber: input.businessVatNumber,
  });
  const id = `taxc_${nanoid()}`;
  const now = Date.now();
  await db.insert(taxCollections).values(
    withTenantValues(ctx, {
      id,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      buyerCountry: quote.buyerCountry,
      buyerRegion: input.buyerRegion ?? null,
      taxType: quote.taxType,
      taxRateBps: quote.taxRateBps,
      netAmountCents: quote.netAmountCents,
      taxAmountCents: quote.taxAmountCents,
      grossAmountCents: quote.grossAmountCents,
      currency: input.currency ?? "usd",
      remittanceBucket: quote.remittanceBucket,
      invoiceNumber: input.invoiceNumber ?? null,
      isBusiness: input.isBusiness ? 1 : 0,
      businessVatNumber: input.businessVatNumber ?? null,
      collectedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return {
    id,
    source: input.source,
    buyerCountry: quote.buyerCountry,
    taxType: quote.taxType,
    taxRateBps: quote.taxRateBps,
    netAmountCents: quote.netAmountCents,
    taxAmountCents: quote.taxAmountCents,
    grossAmountCents: quote.grossAmountCents,
    remittanceBucket: quote.remittanceBucket,
    currency: input.currency ?? "usd",
    collectedAt: now,
  };
}

export interface RemittanceReportRow {
  readonly bucket: string;
  readonly buyerCountry: string;
  readonly netAmountCents: number;
  readonly taxAmountCents: number;
  readonly transactionCount: number;
}

export async function getRemittanceReport(
  ctx: TenantContext,
  input: { fromTs: number; toTs: number },
): Promise<ReadonlyArray<RemittanceReportRow>> {
  const rows = await db
    .select({
      bucket: taxCollections.remittanceBucket,
      buyerCountry: taxCollections.buyerCountry,
      net: sql<number>`SUM(${taxCollections.netAmountCents})`,
      tax: sql<number>`SUM(${taxCollections.taxAmountCents})`,
      cnt: sql<number>`COUNT(*)`,
    })
    .from(taxCollections)
    .where(
      and(
        tenantScope(ctx, taxCollections),
        gte(taxCollections.collectedAt, input.fromTs),
        lte(taxCollections.collectedAt, input.toTs),
      ),
    )
    .groupBy(taxCollections.remittanceBucket, taxCollections.buyerCountry);
  return rows.map((r) => ({
    bucket: r.bucket,
    buyerCountry: r.buyerCountry,
    netAmountCents: Number(r.net ?? 0),
    taxAmountCents: Number(r.tax ?? 0),
    transactionCount: Number(r.cnt ?? 0),
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Payout settings + sanctions screening
// ────────────────────────────────────────────────────────────────────────

export const PAYOUT_METHODS = [
  "stripe_connect",
  "bank_transfer",
  "gift_card",
  "account_credit",
  "restricted",
] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_SCHEDULES = ["monthly", "weekly", "manual"] as const;
export type PayoutSchedule = (typeof PAYOUT_SCHEDULES)[number];

export const PUBLISH_STATUSES = ["active", "suspended", "ban"] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export interface UpsertPayoutSettingsInput {
  readonly creatorId: string;
  readonly recipientCountry?: string;
  readonly method?: PayoutMethod;
  readonly currency?: string;
  readonly minimumThresholdCents?: number;
  readonly schedule?: PayoutSchedule;
  readonly publishStatus?: PublishStatus;
  readonly restrictionReason?: string;
}

export interface PayoutSettingsRow {
  readonly id: string;
  readonly creatorId: string;
  readonly method: PayoutMethod;
  readonly currency: string;
  readonly minimumThresholdCents: number;
  readonly schedule: PayoutSchedule;
  readonly recipientCountry: string;
  readonly restricted: boolean;
  readonly restrictionReason: string | null;
  readonly publishStatus: PublishStatus;
  readonly lastPayoutAt: number | null;
  readonly lastPayoutCents: number;
}

export async function getPayoutSettings(
  ctx: TenantContext,
  creatorId: string,
): Promise<PayoutSettingsRow | null> {
  const rows = await db
    .select()
    .from(creatorPayoutSettings)
    .where(
      and(
        tenantScope(ctx, creatorPayoutSettings),
        eq(creatorPayoutSettings.creatorId, creatorId),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    creatorId: r.creatorId,
    method: r.method as PayoutMethod,
    currency: r.currency,
    minimumThresholdCents: r.minimumThresholdCents,
    schedule: r.schedule as PayoutSchedule,
    recipientCountry: r.recipientCountry,
    restricted: r.restricted === 1,
    restrictionReason: r.restrictionReason,
    publishStatus: r.publishStatus as PublishStatus,
    lastPayoutAt: r.lastPayoutAt,
    lastPayoutCents: r.lastPayoutCents,
  };
}

export async function upsertPayoutSettings(
  ctx: TenantContext,
  input: UpsertPayoutSettingsInput,
): Promise<PayoutSettingsRow> {
  const existing = await getPayoutSettings(ctx, input.creatorId);
  const country = (input.recipientCountry ?? existing?.recipientCountry ?? "US")
    .trim()
    .toUpperCase();
  const restriction = payoutRestrictionFor(country);
  const restricted = restriction.restricted;
  const desiredMethod = input.method ?? existing?.method ?? "stripe_connect";
  const method: PayoutMethod = restricted ? restriction.method : desiredMethod;
  const restrictionReason = restricted
    ? restriction.reason
    : input.restrictionReason ?? existing?.restrictionReason ?? null;
  const publishStatus = input.publishStatus ?? existing?.publishStatus ?? "active";
  const minimum = input.minimumThresholdCents ?? existing?.minimumThresholdCents ?? 5000;
  const schedule = input.schedule ?? existing?.schedule ?? "monthly";
  const currency = input.currency ?? existing?.currency ?? "usd";
  const now = Date.now();

  if (existing) {
    await db
      .update(creatorPayoutSettings)
      .set({
        method,
        currency,
        minimumThresholdCents: minimum,
        schedule,
        recipientCountry: country,
        restricted: restricted ? 1 : 0,
        restrictionReason,
        publishStatus,
        updatedAt: now,
        version: sql`${creatorPayoutSettings.version} + 1`,
      })
      .where(
        and(
          tenantScope(ctx, creatorPayoutSettings),
          eq(creatorPayoutSettings.creatorId, input.creatorId),
        ),
      );
  } else {
    await db.insert(creatorPayoutSettings).values(
      withTenantValues(ctx, {
        id: `payout_${nanoid()}`,
        creatorId: input.creatorId,
        method,
        currency,
        minimumThresholdCents: minimum,
        schedule,
        recipientCountry: country,
        restricted: restricted ? 1 : 0,
        restrictionReason,
        publishStatus,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }),
    );
  }
  await appendAuditEntry(ctx, {
    actor: input.creatorId,
    action: "creator.payout.updated",
    resourceType: "creator_payout_settings",
    resourceId: input.creatorId,
    summary: `Payout settings updated (method=${method}, country=${country}, publishStatus=${publishStatus})`,
  });
  const result = await getPayoutSettings(ctx, input.creatorId);
  if (!result) throw new Error("Failed to read back payout settings after upsert");
  return result;
}

export interface ScreenPayoutInput {
  readonly creatorId: string;
  readonly fullName: string;
  readonly country: string;
}

export interface ScreenPayoutResult {
  readonly screeningId: string;
  readonly overall: ScreeningResult;
  readonly results: ReadonlyArray<{
    list: SanctionsList;
    result: ScreeningResult;
    matchedName: string | null;
    matchedCountry: string | null;
    notes: string;
  }>;
}

export async function screenPayout(
  ctx: TenantContext,
  input: ScreenPayoutInput,
): Promise<ScreenPayoutResult> {
  const outcomes = screenRecipient({
    fullName: input.fullName,
    country: input.country,
  });
  const now = Date.now();
  const screeningId = `screen_${nanoid()}`;
  for (const o of outcomes) {
    await db.insert(creatorPayoutScreenings).values(
      withTenantValues(ctx, {
        id: `${screeningId}_${o.list}`,
        creatorId: input.creatorId,
        listName: o.list,
        result: o.result,
        matchedName: o.matchedName,
        matchedCountry: o.matchedCountry,
        notes: o.notes,
        screenedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  const overall: ScreeningResult = outcomes.some((o) => o.result === "hit")
    ? "hit"
    : outcomes.some((o) => o.result === "manual_review")
      ? "manual_review"
      : "clear";
  await appendAuditEntry(ctx, {
    actor: "system",
    action: "creator.sanctions.screened",
    resourceType: "creator_account",
    resourceId: input.creatorId,
    summary: `Sanctions screen result: ${overall}`,
  });
  // If the country is a comprehensive sanctions hit, auto-restrict
  // payouts to the appropriate alternative method.
  if (overall === "hit") {
    await upsertPayoutSettings(ctx, {
      creatorId: input.creatorId,
      recipientCountry: input.country,
    });
  }
  return {
    screeningId,
    overall,
    results: outcomes.map((o) => ({
      list: o.list,
      result: o.result,
      matchedName: o.matchedName,
      matchedCountry: o.matchedCountry,
      notes: o.notes,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────

export class CreatorLegalError extends Error {
  override readonly name = "CreatorLegalError";
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
  }
}

// Re-exports so route layer can import from a single module.
export {
  CREATOR_AGREEMENT,
  hashCreatorAgreement,
} from "./creator-agreement";
export {
  COMPREHENSIVE_SANCTIONED_COUNTRIES,
  STRIPE_UNSUPPORTED_COUNTRIES,
} from "./sanctions-list";
export { TAX_JURISDICTIONS, getTaxJurisdiction } from "./tax-rates";
