/**
 * /api/conversations — multi-conversation management API surface (Task #41).
 *
 * Endpoints:
 *   GET    /                       — paginated conversation list (filter by
 *                                    archive / pin / title q).
 *   POST   /                       — create a new (empty) conversation.
 *   GET    /:id                    — singleton conversation lookup.
 *   PATCH  /:id                    — rename / pin / archive / set agent mode.
 *   DELETE /:id                    — permanently delete conversation +
 *                                    cascade messages, tool_calls, approvals.
 *   GET    /:id/messages           — paginated transcript.
 *   POST   /:id/messages           — append a chat-mode message turn.
 *   GET    /:id/export             — markdown or JSON dump.
 *   GET    /search?q=…             — full-text search across all
 *                                    conversations in the tenant.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import multer from "multer";
import pdfParse from "pdf-parse";

import { err, ok, pageOk } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  exportConversation,
  getConversation,
  listConversationMessages,
  listConversations,
  searchConversations,
  updateConversation,
} from "../../services/conversation.service";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are accepted"));
  },
});
import {
  getConversationContextUsage,
  resetConversationContext,
  setMessagePin,
} from "../../services/context.service";

const router: IRouter = Router();

// PDF attachment upload — multer processes the multipart body, pdf-parse
// extracts the text, and we persist it as a system message so the model
// has the full document in context across reloads.
router.post(
  "/:id/attachments",
  requireTenant(),
  upload.single("file"),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const conv = await getConversation(ctx, String(req.params.id));
      if (!conv) {
        res.status(404).json(err("NOT_FOUND", "Conversation not found"));
        return;
      }
      if (!req.file) {
        res.status(400).json(err("VALIDATION", "No file uploaded"));
        return;
      }
      let text: string;
      try {
        const result = await pdfParse(req.file.buffer);
        text = result.text.trim();
      } catch {
        res.status(422).json(err("PDF_PARSE_FAILED", "Could not extract text from PDF"));
        return;
      }
      if (!text) {
        res.status(422).json(err("PDF_EMPTY", "PDF contained no extractable text"));
        return;
      }
      const filename = req.file.originalname;
      await appendMessage(ctx, String(req.params.id), {
        role: "system",
        content: `[DOCUMENT: ${filename}]\n\n${text}`,
      });
      res.json(
        ok({
          filename,
          characterCount: text.length,
          wordCount: text.split(/\s+/).filter(Boolean).length,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);

const PageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  includeArchived: z.coerce.boolean().optional(),
  archivedOnly: z.coerce.boolean().optional(),
  q: z.string().min(1).max(200).optional(),
  since: z.string().min(1).max(64).optional(),
  agentOnly: z.coerce.boolean().optional(),
  desktopOnly: z.coerce.boolean().optional(),
});

const CreateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  agentMode: z.boolean().optional(),
  modelName: z.string().min(1).max(200).optional(),
});

const UpdateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    agentMode: z.boolean().optional(),
    modelName: z.string().min(1).max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });

const AppendMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1).max(64_000),
  runId: z.string().min(1).max(120).nullable().optional(),
});

const SearchSchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

const ExportSchema = z.object({
  format: z.enum(["markdown", "json", "pdf"]).default("markdown"),
});

const MessagePageSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

router.get("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = PageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid list params"));
      return;
    }
    const page = await listConversations(ctx, parsed.data);
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid conversation payload"));
      return;
    }
    const row = await createConversation(ctx, parsed.data);
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.get("/search", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SearchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid search params"));
      return;
    }
    const limitOpt = parsed.data.limit;
    const hits = await searchConversations(
      ctx,
      parsed.data.q,
      limitOpt !== undefined ? { limit: limitOpt } : {},
    );
    res.json(ok({ items: hits, query: parsed.data.q }));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getConversation(ctx, String(req.params.id));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid update payload"));
      return;
    }
    const row = await updateConversation(
      ctx,
      String(req.params.id),
      parsed.data,
    );
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const result = await deleteConversation(ctx, String(req.params.id));
    if (!result.deleted) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

router.get("/:id/messages", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = MessagePageSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid pagination params"));
      return;
    }
    const conv = await getConversation(ctx, String(req.params.id));
    if (!conv) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    const page = await listConversationMessages(
      ctx,
      String(req.params.id),
      parsed.data,
    );
    res.json(pageOk(page.items, page.nextCursor));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/messages", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = AppendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid message payload"));
      return;
    }
    const conv = await getConversation(ctx, String(req.params.id));
    if (!conv) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    const result = await appendMessage(ctx, String(req.params.id), parsed.data);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

const ContextQuerySchema = z.object({
  model: z.string().min(1).max(200).optional(),
  pendingInput: z.string().max(64_000).optional(),
});

router.get("/:id/context", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ContextQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid context query"));
      return;
    }
    const conv = await getConversation(ctx, String(req.params.id));
    if (!conv) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    const usage = await getConversationContextUsage(
      ctx,
      String(req.params.id),
      parsed.data.model ?? conv.modelName,
      parsed.data.pendingInput ?? null,
    );
    res.json(ok(usage));
  } catch (e) {
    next(e);
  }
});

router.post("/:id/context/reset", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const conv = await getConversation(ctx, String(req.params.id));
    if (!conv) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    const result = await resetConversationContext(ctx, String(req.params.id));
    res.json(
      ok({
        contextResetTs: new Date(result.contextResetTs).toISOString(),
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.post(
  "/:id/messages/:msgId/pin",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const result = await setMessagePin(
        ctx,
        String(req.params.id),
        String(req.params.msgId),
        true,
      );
      if (!result) {
        res.status(404).json(err("NOT_FOUND", "Message not found"));
        return;
      }
      res.json(
        ok({
          id: result.id,
          pinned: result.pinned,
          pinnedAt: result.pinnedAt
            ? new Date(result.pinnedAt).toISOString()
            : null,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);

router.delete(
  "/:id/messages/:msgId/pin",
  requireTenant(),
  async (req, res, next) => {
    try {
      const ctx = requireTenantContext();
      const result = await setMessagePin(
        ctx,
        String(req.params.id),
        String(req.params.msgId),
        false,
      );
      if (!result) {
        res.status(404).json(err("NOT_FOUND", "Message not found"));
        return;
      }
      res.json(ok({ id: result.id, pinned: false, pinnedAt: null }));
    } catch (e) {
      next(e);
    }
  },
);

router.get("/:id/export", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ExportSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid export params"));
      return;
    }
    const payload = await exportConversation(
      ctx,
      String(req.params.id),
      parsed.data.format,
    );
    if (!payload) {
      res.status(404).json(err("NOT_FOUND", "Conversation not found"));
      return;
    }
    res.json(
      ok({
        format: payload.format,
        filename: payload.filename,
        contentType: payload.contentType,
        body: payload.body,
        ...(payload.encoding ? { encoding: payload.encoding } : {}),
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
