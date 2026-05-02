/**
 * /api/legal — legal document catalogue, acceptance ledger, EU-AI-Act
 * incident reports, model licence summary, and the COPPA / GDPR-K age
 * confirmation gate (Task #25).
 *
 * Routes:
 *   GET  /documents                  list every document with hash + version
 *   GET  /documents/:type            fetch one document's full body
 *   GET  /acceptances                list accepted documents (this tenant)
 *   GET  /acceptances/state          { pending, accepted } — drives the gate
 *   POST /acceptances                record an acceptance for one document
 *   GET  /model-licences             full model licence catalogue
 *   GET  /model-licences/:id         one model's licence (singleton)
 *   GET  /incidents                  paginated incident-report list
 *   POST /incidents                  submit an incident report
 *   GET  /age-confirmation           current age-gate verdict
 *   PUT  /age-confirmation           confirm jurisdiction + age
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  AGE_JURISDICTIONS,
  createIncidentReport,
  fetchLegalDocument,
  fetchModelLicence,
  getAcceptanceState,
  getAgeConfirmation,
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  LEGAL_DOCUMENT_TYPES,
  listAcceptances,
  listIncidentReports,
  listLegalDocuments,
  listModelLicences,
  minimumAgeFor,
  recordAcceptance,
  upsertAgeConfirmation,
  type AgeJurisdiction,
  type IncidentCategory,
  type IncidentSeverity,
  type LegalDocumentType,
} from "../../services/legal.service";

const router: IRouter = Router();

const DocumentTypeSchema = z.enum(LEGAL_DOCUMENT_TYPES);
const IncidentCategorySchema = z.enum(INCIDENT_CATEGORIES);
const IncidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
const JurisdictionSchema = z.enum(AGE_JURISDICTIONS);

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const RecordAcceptanceSchema = z.object({
  documentType: DocumentTypeSchema,
  locale: z.string().min(2).max(20).optional(),
});

const CreateIncidentSchema = z.object({
  category: IncidentCategorySchema,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(8000),
  severity: IncidentSeveritySchema.optional(),
  relatedRunId: z.string().max(120).optional(),
  relatedApprovalId: z.string().max(120).optional(),
  contactEmail: z.string().email().max(320).optional(),
});

const AgeConfirmationSchema = z.object({
  jurisdiction: JurisdictionSchema,
  confirmed: z.boolean(),
});

router.get("/documents", (_req, res) => {
  res.json(ok({ items: listLegalDocuments() }));
});

router.get("/documents/:type", (req, res) => {
  const parsed = DocumentTypeSchema.safeParse(req.params["type"]);
  if (!parsed.success) {
    res.status(400).json(err("VALIDATION", "Unknown document type"));
    return;
  }
  const doc = fetchLegalDocument(parsed.data as LegalDocumentType);
  if (!doc) {
    res.status(404).json(err("NOT_FOUND", "Document not found"));
    return;
  }
  res.json(ok({ document: doc }));
});

router.get("/acceptances", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const items = await listAcceptances(ctx);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.get("/acceptances/state", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const state = await getAcceptanceState(ctx);
    res.json(ok(state));
  } catch (e) {
    next(e);
  }
});

router.post("/acceptances", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RecordAcceptanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid acceptance payload"));
      return;
    }
    const ua = req.header("user-agent") ?? undefined;
    const result = await recordAcceptance(ctx, {
      documentType: parsed.data.documentType,
      ...(parsed.data.locale !== undefined ? { locale: parsed.data.locale } : {}),
      ...(ua !== undefined ? { userAgent: ua } : {}),
    });
    if ("error" in result) {
      res.status(400).json(err(result.error, "Unknown legal document"));
      return;
    }
    res.json(ok({ acceptance: result }));
  } catch (e) {
    next(e);
  }
});

router.get("/model-licences", (_req, res) => {
  res.json(ok({ items: listModelLicences() }));
});

router.get("/model-licences/:id", (req, res) => {
  const id = String(req.params["id"] ?? "");
  const entry = fetchModelLicence(id);
  if (!entry) {
    res.status(404).json(err("NOT_FOUND", "Model licence not found"));
    return;
  }
  res.json(ok({ licence: entry }));
});

router.get("/incidents", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listIncidentReports(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/incidents", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateIncidentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid incident report"));
      return;
    }
    const input: Parameters<typeof createIncidentReport>[1] = {
      category: parsed.data.category as IncidentCategory,
      title: parsed.data.title,
      description: parsed.data.description,
    };
    if (parsed.data.severity !== undefined) input.severity = parsed.data.severity as IncidentSeverity;
    if (parsed.data.relatedRunId !== undefined) input.relatedRunId = parsed.data.relatedRunId;
    if (parsed.data.relatedApprovalId !== undefined) input.relatedApprovalId = parsed.data.relatedApprovalId;
    if (parsed.data.contactEmail !== undefined) input.contactEmail = parsed.data.contactEmail;
    const row = await createIncidentReport(ctx, input);
    res.json(ok({ incident: row }));
  } catch (e) {
    next(e);
  }
});

router.get("/age-confirmation", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getAgeConfirmation(ctx);
    res.json(
      ok({
        confirmation: row,
        minimumAges: {
          us: minimumAgeFor("us"),
          eu: minimumAgeFor("eu"),
          uk: minimumAgeFor("uk"),
          global: minimumAgeFor("global"),
        },
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.put("/age-confirmation", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = AgeConfirmationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid age-confirmation payload"));
      return;
    }
    const row = await upsertAgeConfirmation(ctx, {
      jurisdiction: parsed.data.jurisdiction as AgeJurisdiction,
      confirmed: parsed.data.confirmed,
    });
    res.json(ok({ confirmation: row }));
  } catch (e) {
    next(e);
  }
});

export default router;
