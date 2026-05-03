/**
 * /api/chat — single-turn chat completion against the *active* runtime.
 *
 * Cloud runtimes refuse to chat unless the session has been confirmed via
 * `POST /api/runtimes/{id}/confirm-session`. The 412 PRECONDITION_REQUIRED
 * response carries the runtime id and residency so the client can prompt
 * the user with the right copy.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { listConfirmedRuntimeIds } from "../../lib/cloud-session";
import { requireTenantContext } from "../../lib/tenant-context";
import { requireTenant } from "../../middlewares/tenant-context";
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
});

router.post("/", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid chat payload"));
      return;
    }
    try {
      const result = await chatWithActiveRuntime(
        ctx,
        {
          model: parsed.data.model ?? "",
          messages: parsed.data.messages,
          ...(parsed.data.temperature !== undefined
            ? { temperature: parsed.data.temperature }
            : {}),
        },
        listConfirmedRuntimeIds(req),
      );
      res.json(ok(result));
    } catch (e) {
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
