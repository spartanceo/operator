/**
 * /api/chat — single-turn chat completion against the local Ollama model.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import { chat } from "../../services/ollama.service";

const router: IRouter = Router();

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().min(1).max(32_000),
});

const ChatSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  messages: z.array(MessageSchema).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid chat payload"));
      return;
    }
    const result = await chat(ctx, {
      model: parsed.data.model ?? "llama3",
      messages: parsed.data.messages,
      temperature: parsed.data.temperature,
    });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
