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
 *
 * Tool dispatch (Task #293): conversation-mode requests (those with a
 * `conversationId`) receive injected tool-prompt instructions so the model
 * can call web_search, media.image.generate, and media.audio.generate.
 * The streaming route accumulates the first response server-side; if a tool
 * call is detected it dispatches the tool and opens a second stream with the
 * updated message list. Raw completions (no conversationId) are unaffected.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { listConfirmedRuntimeIds } from "../../lib/cloud-session";
import {
  injectToolPrompts,
  tryParseConversationToolCall,
} from "../../lib/conversation-tools";
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

      // Inject tool prompts into conversation-mode requests so the model
      // knows it can call tools.  For non-conversation requests (raw
      // completions, agent steps) we leave messages untouched.
      let messagesForChat: RuntimeChatMessage[] = messagesToSend;
      if (parsed.data.conversationId) {
        messagesForChat = injectToolPrompts(messagesToSend);
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
      // mode.  If the model responds with a tool-call JSON envelope, we
      // dispatch the tool, append the result, and re-call the model so it can
      // compose a final human-readable answer.
      if (parsed.data.conversationId) {
        const toolCall = tryParseConversationToolCall(result.message.content);
        if (toolCall) {
          try {
            const toolResult = await invokeTool(ctx, toolCall.name, toolCall.args);
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
            // Tool dispatch failed — ask the model to answer from its own
            // knowledge so the user receives a helpful reply, not raw JSON.
            const fallbackMessages: RuntimeChatMessage[] = [
              ...messagesForChat,
              result.message,
              {
                role: "tool",
                content: JSON.stringify({ error: "Tool unavailable — answer from built-in knowledge." }),
              },
            ];
            try {
              result = await chatWithActiveRuntime(
                ctx,
                { ...chatReq, messages: fallbackMessages },
                confirmed,
              );
            } catch {
              // If the fallback call also fails, result keeps its last value
              // (the tool-call envelope). At minimum the user sees a response.
            }
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

    // Inject tool prompts for conversation-mode requests only.
    let messagesForChat: RuntimeChatMessage[] = messagesToSend;
    if (parsed.data.conversationId) {
      messagesForChat = injectToolPrompts(messagesToSend);
    }

    const chatReq = {
      model: parsed.data.model ?? "",
      messages: messagesForChat,
      ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
    };

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      // Phase 1 — Accumulate the first response server-side so we can check
      // for a tool-call envelope before committing anything to the client.
      // If no tool call is detected we flush the accumulated chunks immediately
      // so the client experience is identical to the no-tool path.
      let firstContent = "";
      let firstChunks: unknown[] = [];

      if (parsed.data.conversationId) {
        const stream = streamChatWithActiveRuntime(ctx, chatReq, confirmed);
        for await (const chunk of stream) {
          firstChunks.push(chunk);
          if (chunk.delta) {
            firstContent += chunk.delta;
          }
        }

        // Phase 2 — Check for a tool call in the accumulated content.
        const toolCall = tryParseConversationToolCall(firstContent);
        if (toolCall) {
          // Invoke the tool and open a second stream with results appended.
          try {
            const toolResult = await invokeTool(ctx, toolCall.name, toolCall.args);
            const toolResultContent = JSON.stringify(toolResult.output);

            // Emit the tool result as a special SSE event so the client can
            // render inline media (images, audio) before the follow-up text
            // arrives.
            res.write(
              `data: ${JSON.stringify({ toolResult: { name: toolCall.name, output: toolResult.output } })}\n\n`,
            );

            const messagesWithResult: RuntimeChatMessage[] = [
              ...messagesForChat,
              { role: "assistant", content: firstContent },
              { role: "tool", content: toolResultContent },
            ];
            const stream2 = streamChatWithActiveRuntime(
              ctx,
              { ...chatReq, messages: messagesWithResult },
              confirmed,
            );
            for await (const chunk of stream2) {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          } catch {
            // Tool dispatch failed — ask the model to answer from its own
            // knowledge so the user receives a helpful reply, not raw JSON.
            const fallbackMessages: RuntimeChatMessage[] = [
              ...messagesForChat,
              { role: "assistant", content: firstContent },
              {
                role: "tool",
                content: JSON.stringify({ error: "Tool unavailable — answer from built-in knowledge." }),
              },
            ];
            try {
              const fallbackStream = streamChatWithActiveRuntime(
                ctx,
                { ...chatReq, messages: fallbackMessages },
                confirmed,
              );
              for await (const chunk of fallbackStream) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } catch {
              // If the fallback stream also fails, flush the original chunks
              // so the user sees something rather than a silent hang.
              for (const chunk of firstChunks) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            }
          }
        } else {
          // No tool call — flush the already-accumulated first-stream chunks.
          for (const chunk of firstChunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }
      } else {
        // Raw completion (no conversationId) — stream directly with no tool
        // prompt injection or tool-call detection.
        const stream = streamChatWithActiveRuntime(ctx, chatReq, confirmed);
        for await (const chunk of stream) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
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
