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
  streamChatWithActiveRuntime,
} from "../../services/runtime.service";
import { invokeTool } from "../../services/tools.service";
import type { RuntimeChatMessage } from "../../services/runtime/types";

/**
 * System message injected into every conversation-mode chat request to
 * enable web_search tool calling via a structured JSON response format.
 *
 * When the model needs to search the web it MUST reply with ONLY the JSON
 * block below (no other text).  The route parses this, dispatches the tool,
 * then calls the model again with the results so it can produce a final
 * answer.
 */
const WEB_SEARCH_TOOL_MSG =
  "You have access to a real-time web search tool.\n" +
  "When the user asks you to search for something, or when you need current\n" +
  "information to answer accurately, reply with ONLY the following JSON\n" +
  "(no markdown fences, no other text):\n" +
  '{"__tool_call__":{"name":"web_search","arguments":{"query":"<your search query>","count":5}}}\n' +
  "After receiving search results, provide a helpful, concise answer.";

/**
 * Try to parse a web_search tool call from the model's raw response content.
 * Accepts bare JSON or JSON wrapped in a markdown code fence.
 * Returns null if the content is not a tool call.
 */
function tryParseWebSearchCall(
  content: string,
): { query: string; count: number } | null {
  const trimmed = content.trim();

  function extract(raw: string): { query: string; count: number } | null {
    try {
      const parsed = JSON.parse(raw) as {
        __tool_call__?: { name?: string; arguments?: { query?: string; count?: number } };
      };
      if (
        parsed.__tool_call__?.name === "web_search" &&
        typeof parsed.__tool_call__.arguments?.query === "string"
      ) {
        return {
          query: parsed.__tool_call__.arguments.query,
          count: Math.max(1, Math.min(10, parsed.__tool_call__.arguments.count ?? 5)),
        };
      }
    } catch {
      // not valid JSON
    }
    return null;
  }

  // 1. Bare JSON
  const bare = extract(trimmed);
  if (bare) return bare;

  // 2. Wrapped in a markdown code fence (```json … ``` or ``` … ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return extract(fenceMatch[1].trim());

  return null;
}

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
      let kbSources: string[] = [];
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
        kbSources = prepared.kbSources;
      }

      // Inject the web_search tool prompt into conversation-mode requests so
      // the model knows it can call the tool.  For non-conversation requests
      // (raw completions, agent steps) we leave messages untouched to avoid
      // confusing the model with unexpected instructions.
      let messagesForChat: RuntimeChatMessage[] = messagesToSend;
      if (parsed.data.conversationId) {
        if (messagesForChat.length > 0 && messagesForChat[0].role === "system") {
          messagesForChat = [
            { role: "system", content: messagesForChat[0].content + "\n\n" + WEB_SEARCH_TOOL_MSG },
            ...messagesForChat.slice(1),
          ];
        } else {
          messagesForChat = [
            { role: "system", content: WEB_SEARCH_TOOL_MSG },
            ...messagesForChat,
          ];
        }
      }

      const chatReq = {
        model: parsed.data.model ?? "",
        messages: messagesForChat,
        ...(parsed.data.temperature !== undefined
          ? { temperature: parsed.data.temperature }
          : {}),
      };

      let result = await chatWithActiveRuntime(ctx, chatReq, confirmed);

      // Tool-call dispatch loop (single round) — only active for conversation
      // mode.  If the model responds with a web_search JSON call block, we
      // dispatch the tool, append the result, and re-call the model so it can
      // compose a final human-readable answer.
      if (parsed.data.conversationId) {
        const toolCall = tryParseWebSearchCall(result.message.content);
        if (toolCall) {
          try {
            const toolResult = await invokeTool(ctx, "web_search", {
              query: toolCall.query,
              count: toolCall.count,
            });
            const messagesWithResult: RuntimeChatMessage[] = [
              ...messagesForChat,
              result.message,
              {
                role: "tool",
                content: JSON.stringify(toolResult.output),
              },
            ];
            result = await chatWithActiveRuntime(
              ctx,
              { ...chatReq, messages: messagesWithResult },
              confirmed,
            );
          } catch {
            // Tool dispatch failed — return the raw model response so the user
            // sees something rather than an opaque error.
          }
        }
      }

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
          kbSources,
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

router.post("/stream", requireTenant(), async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid chat payload"));
      return;
    }
    const confirmed = listConfirmedRuntimeIds(req);
    let messagesToSend = parsed.data.messages;
    let streamKbSources: string[] = [];
    if (parsed.data.conversationId) {
      const lastUser = parsed.data.messages[parsed.data.messages.length - 1];
      const pendingInput = lastUser?.content ?? "";
      try {
        const prepared = await prepareChatContext(
          ctx,
          parsed.data.conversationId,
          pendingInput,
          parsed.data.model ?? null,
          confirmed,
        );
        messagesToSend = prepared.messages;
        streamKbSources = prepared.kbSources;
      } catch (e) {
        if (e instanceof OverflowError) {
          res.status(413).json(err("CONTEXT_OVERFLOW", e.suggestion, { usage: e.usage }));
          return;
        }
        throw e;
      }
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    try {
      const stream = streamChatWithActiveRuntime(
        ctx,
        {
          model: parsed.data.model ?? "",
          messages: messagesToSend,
          ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
        },
        confirmed,
      );
      for await (const chunk of stream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    } catch (e) {
      if (e instanceof CloudConsentRequiredError) {
        res.write(`data: ${JSON.stringify({ error: "CLOUD_CONSENT_REQUIRED" })}\n\n`);
      } else if (e instanceof CloudCredentialMissingError) {
        res.write(`data: ${JSON.stringify({ error: "MISSING_CREDENTIALS" })}\n\n`);
      } else if (e instanceof RuntimeUnavailableError) {
        res.write(`data: ${JSON.stringify({ error: "RUNTIME_UNAVAILABLE" })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ error: "STREAM_ERROR" })}\n\n`);
      }
    }
    if (streamKbSources.length > 0) {
      res.write(`data: ${JSON.stringify({ kbSources: streamKbSources })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    next(e);
  }
});

export default router;
