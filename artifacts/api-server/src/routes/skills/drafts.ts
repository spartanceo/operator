/**
 * /api/skills/drafts — no-code Skill Creator wizard endpoints.
 *
 * Three entry paths feed a unified draft pipeline (upload, paste,
 * interview). Drafts never leave the local tenant; the publish
 * action is in `./store.ts`.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  answerInterview,
  createDraftFromPaste,
  createDraftFromUpload,
  deleteDraft,
  DraftNotFoundError,
  DraftValidationError,
  getDraft,
  INTERVIEW_QUESTIONS,
  listDrafts,
  startInterviewDraft,
  testDraft,
  updateDraft,
} from "../../services/skill-draft.service";

const router: IRouter = Router();

const MAX_TEXT_PASTE = 64_000;

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const StringArray = z.array(z.string().min(1).max(200)).max(20);

const UploadSchema = z.object({
  fileName: z.string().min(1).max(200),
  kind: z.string().min(1).max(20),
  base64: z.string().max(2_500_000).optional(),
  text: z.string().max(MAX_TEXT_PASTE).optional(),
});

const PasteSchema = z.object({
  text: z.string().min(20).max(MAX_TEXT_PASTE),
});

const InterviewAnswerSchema = z.object({
  answer: z.string().min(1).max(4_000),
});

const UpdateDraftSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  content: z.string().min(1).max(64_000).optional(),
  modelTags: StringArray.optional(),
  triggers: StringArray.optional(),
  examplePrompts: StringArray.optional(),
  category: z.string().min(1).max(80).optional(),
});

const TestSchema = z.object({
  message: z.string().min(1).max(4_000),
  modelName: z.string().min(1).max(200).optional(),
});

function handleDraftError(e: unknown, res: import("express").Response): boolean {
  if (e instanceof DraftNotFoundError) {
    res.status(404).json(err(e.code, e.message));
    return true;
  }
  if (e instanceof DraftValidationError) {
    res.status(400).json(err(e.code, e.message));
    return true;
  }
  return false;
}

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const page = await listDrafts(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.get("/interview/questions", requireTenant(), (_req, res) => {
  res.json(ok({ questions: [...INTERVIEW_QUESTIONS] }));
});

router.post("/upload", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid upload payload"));
      return;
    }
    const row = await createDraftFromUpload(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleDraftError(e, res)) return;
    next(e);
  }
});

router.post("/paste", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PasteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid paste payload"));
      return;
    }
    const row = await createDraftFromPaste(ctx, parsed.data.text);
    res.json(ok(row));
  } catch (e) {
    if (handleDraftError(e, res)) return;
    next(e);
  }
});

router.post("/interview/start", requireTenant(), async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await startInterviewDraft(ctx);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/interview/answer", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = InterviewAnswerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid interview answer"));
      return;
    }
    const row = await answerInterview(ctx, String(req.params["id"]), parsed.data.answer);
    res.json(ok(row));
  } catch (e) {
    if (handleDraftError(e, res)) return;
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getDraft(ctx, String(req.params["id"]));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Draft not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid draft payload"));
      return;
    }
    const row = await updateDraft(ctx, String(req.params["id"]), parsed.data);
    res.json(ok(row));
  } catch (e) {
    if (handleDraftError(e, res)) return;
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteDraft(ctx, String(req.params["id"]));
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/test", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = TestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid test payload"));
      return;
    }
    const result = await testDraft(ctx, String(req.params["id"]), parsed.data);
    res.json(ok(result));
  } catch (e) {
    if (handleDraftError(e, res)) return;
    next(e);
  }
});

export default router;
