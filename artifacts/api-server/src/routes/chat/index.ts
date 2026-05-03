/**
 * /api/chat — single-turn chat completion against the *active* runtime.
 *
 * Cloud runtimes refuse to chat unless the session has been confirmed via
 * `POST /api/runtimes/{id}/confirm-session`. The 412 PRECONDITION_REQUIRED
 * response carries the runtime id and residency so the client can prompt
 * the user with the right copy.
 *
 * Context-window management (Task #51): when the request includes a
 * `conversationId`, the route loads the conversation transcript through
 * `prepareChatContext`, which applies pinned-message protection, prior
 * summaries, and rolling summarisation when the prompt would exceed the
 * model's window. Overflow returns 413 with actionable copy instead of
 * silently truncating.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { listConfirmedRuntimeIds } from "../../lib/cloud-session";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  OverflowError,
  prepareChatContext,
} from "../../services/context.service";
import {
  CloudConsentRequiredError,
  CloudCredentialMissingError,
  RuntimeUnavailableError,
  chatWithActiveRuntime,
} from "../../services/runtime.service";

const router: IRouter = Router();

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().min(1).max(32_000),
});

const ChatSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  messages: z.array(MessageSchema).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  conversationId: z.string().min(1).max(120).optional(),
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid chat payload"));
      return;
    }
    const confirmed = listConfirmedRuntimeIds(req);
    try {
      // When a conversationId is present we ignore the verbose `messages`
      // history sent by the client and rebuild it from the persisted
      // transcript via the context manager — this is the only path that
      // honours pinned messages, prior summaries, and overflow protection.
      let messagesToSend = parsed.data.messages;
      let usage = null;
      let summarisedThisCall = false;
      let compressedMessageCount = 0;
      if (parsed.data.conversationId) {
        const lastUser = parsed.data.messages[parsed.data.messages.length - 1];
        const pendingInput = lastUser?.content ?? "";
        const prepared = await prepareChatContext(
          ctx,
          parsed.data.conversationId,
          pendingInput,
          parsed.data.model ?? null,
          confirmed,
        );
        messagesToSend = prepared.messages;
        usage = prepared.usage;
        summarisedThisCall = prepared.summarisedThisCall;
        compressedMessageCount = prepared.compressedMessageCount;
      }
      const result = await chatWithActiveRuntime(
        ctx,
        {
          model: parsed.data.model ?? "",
          messages: messagesToSend,
          ...(parsed.data.temperature !== undefined
            ? { temperature: parsed.data.temperature }
            : {}),
        },
        confirmed,
      );
      res.json(
        ok({
          ...result,
          ...(usage
            ? {
                contextUsage: usage,
                summarisedThisCall,
                compressedMessageCount,
              }
            : {}),
        }),
      );
    } catch (e) {
      if (e instanceof OverflowError) {
        res.status(413).json(
          err("CONTEXT_OVERFLOW", e.suggestion, {
            usage: e.usage,
          }),
        );
        return;
      }
      if (e instanceof CloudConsentRequiredError) {
        res.status(412).json(
          err("CLOUD_CONSENT_REQUIRED", e.message, {
            runtimeId: e.runtimeId,
            residency: e.residency,
          }),
        );
        return;
      }
      if (e instanceof CloudCredentialMissingError) {
        res.status(412).json(
          err(
            "MISSING_CREDENTIALS",
            `Runtime "${e.runtimeId}" needs an API key — add one in Settings → Runtime.`,
            { runtimeId: e.runtimeId },
          ),
        );
        return;
      }
      if (e instanceof RuntimeUnavailableError) {
        res.status(503).json(
          err(
            "RUNTIME_UNAVAILABLE",
            `Runtime "${e.runtimeId}" is unreachable — chat paused until it comes back online.`,
            { runtimeId: e.runtimeId, health: e.health },
          ),
        );
        return;
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

export default router;
