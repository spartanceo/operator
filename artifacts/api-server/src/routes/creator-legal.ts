/**
 * /api/creator-legal — creator legal & tax compliance endpoints (Task #26).
 *
 * Surface area:
 *   GET  /agreement                        Current Creator Agreement (public).
 *   GET  /agreement/state                  Has the current creator accepted?
 *   POST /agreement/sign                   Record a digital signature.
 *
 *   POST /dmca/takedowns                   Public DMCA takedown submission.
 *   GET  /dmca/takedowns                   Admin list (paginated, optional status).
 *   POST /dmca/takedowns/:id/decide        Admin decision (uphold | reject).
 *   POST /dmca/counter-notices             Creator counter-notice for a takedown.
 *
 *   GET  /tax-forms                        Current creator's tax-form state.
 *   POST /tax-forms                        Submit / replace W-9 / W-8BEN.
 *   GET  /tax-documents                    List 1099-K / annual docs.
 *   POST /tax-documents/generate           Admin: generate 1099-K for tax year.
 *
 *   POST /tax/quote                        Public: VAT/GST quote for checkout.
 *   GET  /tax/jurisdictions                Public: list of supported buckets.
 *   GET  /tax/remittance                   Admin: aggregated tax-collection report.
 *
 *   GET  /payout-settings                  Current payout config.
 *   PUT  /payout-settings                  Update payout config.
 *   POST /payout-settings/screen           Run sanctions screening.
 *
 * The DMCA-takedown POST and tax-quote endpoints are intentionally NOT
 * gated by `requireTenant()` — DMCA notices can come from anyone on the
 * public internet (the form lives on the marketing site) and tax quotes
 * are needed at anonymous checkout. They write into the system tenant.
 *
 * Creator-scoped endpoints accept either a tenant header (the operator
 * app's logged-in creator) or a creator API token (the marketing-site
 * creator dashboard). Token auth is identical to /creator/earnings.
 */
import { createHash } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  creatorAccounts,
  db,
  SYSTEM_TENANT_ID,
  SYSTEM_WORKSPACE_ID,
  tenantScope,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { err, ok, pageOk } from "../lib/api-envelope";
import { logger } from "../lib/logger";
import { requireTenantContext, getTenantContext } from "../lib/tenant-context";
import { requireTenant } from "../middlewares/tenant-context";
import {
  CREATOR_AGREEMENT,
  CreatorLegalError,
  DMCA_STATUSES,
  PAYOUT_METHODS,
  PAYOUT_SCHEDULES,
  PUBLISH_STATUSES,
  TAX_FORM_TYPES,
  TAX_JURISDICTIONS,
  decideTakedown,
  generateTaxDocument,
  getAgreementState,
  getCreatorAgreement,
  getPayoutSettings,
  getRemittanceReport,
  getTaxFormState,
  getTaxJurisdiction,
  hashCreatorAgreement,
  listTakedowns,
  listTaxDocuments,
  quoteTaxForCheckout,
  recordTaxCollection,
  screenPayout,
  signAgreement,
  submitCounterNotice,
  submitTakedown,
  submitTaxForm,
  upsertPayoutSettings,
} from "../services/legal/creator-legal.service";

const router: IRouter = Router();

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function publicTenantContext(): TenantContext {
  return {
    tenantId: SYSTEM_TENANT_ID,
    workspaceId: SYSTEM_WORKSPACE_ID,
    requestId: "public-dmca",
  };
}

function clientIp(req: Request): string | undefined {
  const xff = req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim();
  return req.ip ?? undefined;
}

function userAgent(req: Request): string | undefined {
  return req.header("user-agent") ?? undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface CreatorAuthOk {
  ok: true;
  ctx: TenantContext;
  creatorId: string;
}
interface CreatorAuthErr {
  ok: false;
  status: number;
  code: string;
  message: string;
}

/**
 * Resolve the current creator. Two flavours are accepted:
 *
 *   1. Bearer creator API token in `Authorization: Bearer <token>`.
 *      The token is the same one issued at signup; the route reads
 *      `creator_accounts` across the whole DB to find the row, then
 *      pins the tenant context to that creator's owning tenant.
 *
 *   2. A tenant header + `creatorId` query/body parameter. Used by the
 *      operator app where the user is signed in and the creator id is
 *      already known to the client.
 */
async function authenticateCreator(
  req: Request,
  bodyCreatorId?: string,
): Promise<CreatorAuthOk | CreatorAuthErr> {
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    const tokenHash = hashToken(token);
    // We have to look up the creator without a tenant filter because
    // the API token is the only thing the caller has presented. Once
    // we find the row, we pin the tenant context to the row's tenant.
    const rows = await db
      .select()
      .from(creatorAccounts)
      .where(eq(creatorAccounts.apiTokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return {
        ok: false,
        status: 401,
        code: "CREATOR_AUTH",
        message: "Invalid creator API token",
      };
    }
    return {
      ok: true,
      ctx: {
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        requestId: req.header("x-request-id") ?? "creator-token",
      },
      creatorId: row.id,
    };
  }
  const ctx = getTenantContext();
  if (!ctx) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Missing tenant context or creator API token",
    };
  }
  const queryCreator = req.query["creatorId"];
  const creatorId =
    bodyCreatorId ?? (typeof queryCreator === "string" ? queryCreator : undefined);
  if (!creatorId) {
    return {
      ok: false,
      status: 400,
      code: "VALIDATION",
      message: "creatorId is required",
    };
  }
  const [row] = await db
    .select()
    .from(creatorAccounts)
    .where(and(tenantScope(ctx, creatorAccounts), eq(creatorAccounts.id, creatorId)))
    .limit(1);
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Creator not found in this tenant",
    };
  }
  return { ok: true, ctx, creatorId: row.id };
}

function handleErr(e: unknown, fallback: string, res: import("express").Response) {
  if (e instanceof CreatorLegalError) {
    res.status(e.status).json(err(e.code, e.message));
    return;
  }
  logger.error({ err: e }, fallback);
  res.status(500).json(err("INTERNAL", fallback));
}

// ────────────────────────────────────────────────────────────────────────
// Creator Agreement
// ────────────────────────────────────────────────────────────────────────

router.get("/agreement", async (_req, res) => {
  const doc = await getCreatorAgreement();
  res.json(ok({ agreement: doc }));
});

router.get("/agreement/state", async (req, res) => {
  const auth = await authenticateCreator(req);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const state = await getAgreementState(auth.ctx, auth.creatorId);
    res.json(ok(state));
  } catch (e) {
    handleErr(e, "Failed to read agreement state", res);
  }
});

const SignSchema = z.object({
  creatorId: z.string().min(1).max(120).optional(),
  signedName: z.string().min(2).max(200),
  locale: z.string().min(2).max(20).optional(),
});

router.post("/agreement/sign", async (req, res) => {
  const parsed = SignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  const auth = await authenticateCreator(req, parsed.data.creatorId);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const result = await signAgreement(auth.ctx, {
      creatorId: auth.creatorId,
      signedName: parsed.data.signedName,
      ipAddress: clientIp(req),
      userAgent: userAgent(req),
      locale: parsed.data.locale,
    });
    res.json(ok(result));
  } catch (e) {
    handleErr(e, "Failed to sign agreement", res);
  }
});

// ────────────────────────────────────────────────────────────────────────
// DMCA takedowns
// ────────────────────────────────────────────────────────────────────────

const TakedownSchema = z.object({
  storeSkillId: z.string().max(120).optional(),
  creatorHandle: z.string().max(120).optional(),
  skillSlug: z.string().max(200).optional(),
  skillUrl: z.string().url().max(2048).optional(),
  claimantName: z.string().min(2).max(200),
  claimantEmail: z.string().email().max(320),
  claimantAddress: z.string().min(5).max(1000),
  claimantPhone: z.string().max(60).optional(),
  workDescription: z.string().min(10).max(8000),
  infringementDescription: z.string().min(10).max(8000),
  goodFaithStatement: z.boolean(),
  accuracyStatement: z.boolean(),
  signature: z.string().min(2).max(200),
});

router.post("/dmca/takedowns", async (req, res) => {
  const parsed = TakedownSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  // Public endpoint — pin to system tenant so the audit trail lives
  // somewhere queryable by ops without exposing tenant data.
  const ctx = getTenantContext() ?? publicTenantContext();
  try {
    const row = await submitTakedown(ctx, {
      ...parsed.data,
      submitterIp: clientIp(req),
      submitterUserAgent: userAgent(req),
    });
    res.json(ok({ takedown: row }));
  } catch (e) {
    handleErr(e, "Failed to submit DMCA takedown", res);
  }
});

const ListTakedownsSchema = z.object({
  status: z.enum(DMCA_STATUSES).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get("/dmca/takedowns", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ListTakedownsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
      return;
    }
    const page = await listTakedowns(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

const DecideSchema = z.object({
  decision: z.enum(["uphold", "reject"]),
  notes: z.string().max(4000).optional(),
});

router.post("/dmca/takedowns/:id/decide", requireTenant(), async (req, res) => {
  const parsed = DecideSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  const id = req.params["id"];
  if (typeof id !== "string" || !id) {
    res.status(400).json(err("VALIDATION", "Missing takedown id"));
    return;
  }
  try {
    const ctx = requireTenantContext();
    const row = await decideTakedown(ctx, {
      id,
      decision: parsed.data.decision,
      notes: parsed.data.notes,
      actor: ctx.userId ?? "admin",
    });
    res.json(ok({ takedown: row }));
  } catch (e) {
    handleErr(e, "Failed to decide takedown", res);
  }
});

const CounterNoticeSchema = z.object({
  takedownId: z.string().min(1).max(120),
  creatorId: z.string().max(120).optional(),
  creatorName: z.string().min(2).max(200),
  creatorEmail: z.string().email().max(320),
  creatorAddress: z.string().min(5).max(1000),
  statement: z.string().min(10).max(8000),
  consentToJurisdiction: z.boolean(),
  perjuryStatement: z.boolean(),
  signature: z.string().min(2).max(200),
});

router.post("/dmca/counter-notices", async (req, res) => {
  const parsed = CounterNoticeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  const ctx = getTenantContext() ?? publicTenantContext();
  try {
    const result = await submitCounterNotice(ctx, {
      ...parsed.data,
      submitterIp: clientIp(req),
      submitterUserAgent: userAgent(req),
    });
    res.json(ok(result));
  } catch (e) {
    handleErr(e, "Failed to submit counter-notice", res);
  }
});

// ────────────────────────────────────────────────────────────────────────
// Tax forms (W-9 / W-8BEN)
// ────────────────────────────────────────────────────────────────────────

router.get("/tax-forms", async (req, res) => {
  const auth = await authenticateCreator(req);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const state = await getTaxFormState(auth.ctx, auth.creatorId);
    res.json(ok(state));
  } catch (e) {
    handleErr(e, "Failed to read tax form state", res);
  }
});

const TaxFormSchema = z.object({
  creatorId: z.string().min(1).max(120).optional(),
  formType: z.enum(TAX_FORM_TYPES),
  fullName: z.string().min(2).max(200),
  businessName: z.string().max(200).optional(),
  address: z.string().min(5).max(1000),
  taxId: z.string().min(4).max(40),
  countryCode: z.string().length(2),
});

router.post("/tax-forms", async (req, res) => {
  const parsed = TaxFormSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  const auth = await authenticateCreator(req, parsed.data.creatorId);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const state = await submitTaxForm(auth.ctx, {
      creatorId: auth.creatorId,
      formType: parsed.data.formType,
      fullName: parsed.data.fullName,
      businessName: parsed.data.businessName,
      address: parsed.data.address,
      taxId: parsed.data.taxId,
      countryCode: parsed.data.countryCode,
    });
    res.json(ok(state));
  } catch (e) {
    handleErr(e, "Failed to submit tax form", res);
  }
});

// ────────────────────────────────────────────────────────────────────────
// Tax documents — 1099-K
// ────────────────────────────────────────────────────────────────────────

router.get("/tax-documents", async (req, res) => {
  const auth = await authenticateCreator(req);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const items = await listTaxDocuments(auth.ctx, auth.creatorId);
    res.json(ok({ items }));
  } catch (e) {
    handleErr(e, "Failed to list tax documents", res);
  }
});

const GenerateDocSchema = z.object({
  creatorId: z.string().min(1).max(120),
  taxYear: z.number().int().min(2020).max(2100),
  grossAmountCents: z.number().int().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
  backupWithholdingCents: z.number().int().nonnegative().optional(),
  documentType: z
    .enum(["form_1099_k", "form_1099_misc", "annual_summary"])
    .optional(),
});

router.post("/tax-documents/generate", requireTenant(), async (req, res) => {
  const parsed = GenerateDocSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  try {
    const ctx = requireTenantContext();
    const doc = await generateTaxDocument(ctx, parsed.data);
    res.json(ok({ document: doc }));
  } catch (e) {
    handleErr(e, "Failed to generate tax document", res);
  }
});

// ────────────────────────────────────────────────────────────────────────
// Tax quote + collection (VAT/GST)
// ────────────────────────────────────────────────────────────────────────

const QuoteSchema = z.object({
  buyerCountry: z.string().length(2),
  netAmountCents: z.number().int().positive().max(1_000_000_00),
  isBusiness: z.boolean().optional(),
  businessVatNumber: z.string().max(40).optional(),
});

router.post("/tax/quote", (req, res) => {
  const parsed = QuoteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  const quote = quoteTaxForCheckout({
    buyerCountry: parsed.data.buyerCountry,
    netAmountCents: parsed.data.netAmountCents,
    isBusiness: parsed.data.isBusiness,
    businessVatNumber: parsed.data.businessVatNumber,
  });
  const jurisdiction = getTaxJurisdiction(parsed.data.buyerCountry);
  res.json(
    ok({
      quote,
      jurisdiction: jurisdiction
        ? {
            country: jurisdiction.country,
            name: jurisdiction.name,
            taxType: jurisdiction.taxType,
            rateBps: jurisdiction.rateBps,
            remittanceBucket: jurisdiction.remittanceBucket,
          }
        : null,
    }),
  );
});

router.get("/tax/jurisdictions", (_req, res) => {
  res.json(ok({ items: TAX_JURISDICTIONS }));
});

const RecordCollectionSchema = z.object({
  source: z.string().min(1).max(60),
  sourceRef: z.string().max(200).optional(),
  buyerCountry: z.string().length(2),
  buyerRegion: z.string().max(80).optional(),
  netAmountCents: z.number().int().positive().max(1_000_000_00),
  currency: z.string().length(3).optional(),
  isBusiness: z.boolean().optional(),
  businessVatNumber: z.string().max(40).optional(),
  invoiceNumber: z.string().max(80).optional(),
});

router.post("/tax/collections", requireTenant(), async (req, res, next) => {
  const parsed = RecordCollectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  try {
    const ctx = requireTenantContext();
    const collection = await recordTaxCollection(ctx, parsed.data);
    res.json(ok({ collection }));
  } catch (e) {
    next(e);
  }
});

const RemittanceSchema = z.object({
  fromTs: z.coerce.number().int().nonnegative(),
  toTs: z.coerce.number().int().nonnegative(),
});

router.get("/tax/remittance", requireTenant(), async (req, res, next) => {
  const parsed = RemittanceSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  try {
    const ctx = requireTenantContext();
    const items = await getRemittanceReport(ctx, parsed.data);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

// ────────────────────────────────────────────────────────────────────────
// Payout settings + sanctions screening
// ────────────────────────────────────────────────────────────────────────

router.get("/payout-settings", async (req, res) => {
  const auth = await authenticateCreator(req);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const settings = await getPayoutSettings(auth.ctx, auth.creatorId);
    res.json(ok({ settings }));
  } catch (e) {
    handleErr(e, "Failed to read payout settings", res);
  }
});

const PayoutSettingsSchema = z.object({
  creatorId: z.string().min(1).max(120).optional(),
  recipientCountry: z.string().length(2).optional(),
  method: z.enum(PAYOUT_METHODS).optional(),
  currency: z.string().length(3).optional(),
  minimumThresholdCents: z.number().int().nonnegative().optional(),
  schedule: z.enum(PAYOUT_SCHEDULES).optional(),
  publishStatus: z.enum(PUBLISH_STATUSES).optional(),
});

router.put("/payout-settings", async (req, res) => {
  const parsed = PayoutSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  const auth = await authenticateCreator(req, parsed.data.creatorId);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const settings = await upsertPayoutSettings(auth.ctx, {
      creatorId: auth.creatorId,
      recipientCountry: parsed.data.recipientCountry,
      method: parsed.data.method,
      currency: parsed.data.currency,
      minimumThresholdCents: parsed.data.minimumThresholdCents,
      schedule: parsed.data.schedule,
      publishStatus: parsed.data.publishStatus,
    });
    res.json(ok({ settings }));
  } catch (e) {
    handleErr(e, "Failed to update payout settings", res);
  }
});

const ScreenSchema = z.object({
  creatorId: z.string().min(1).max(120).optional(),
  fullName: z.string().min(2).max(200),
  country: z.string().length(2),
});

router.post("/payout-settings/screen", async (req, res) => {
  const parsed = ScreenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid"));
    return;
  }
  const auth = await authenticateCreator(req, parsed.data.creatorId);
  if (!auth.ok) {
    res.status(auth.status).json(err(auth.code, auth.message));
    return;
  }
  try {
    const result = await screenPayout(auth.ctx, {
      creatorId: auth.creatorId,
      fullName: parsed.data.fullName,
      country: parsed.data.country,
    });
    res.json(ok(result));
  } catch (e) {
    handleErr(e, "Failed to run sanctions screening", res);
  }
});

// Surface the static agreement constants for export to the marketing
// site bundle (the public landing page renders the summary).
router.get("/_meta", (_req, res) => {
  res.json(
    ok({
      agreementVersion: CREATOR_AGREEMENT.version,
      agreementHash: hashCreatorAgreement(CREATOR_AGREEMENT),
      effectiveDate: CREATOR_AGREEMENT.effectiveDate,
    }),
  );
});

export default router;
