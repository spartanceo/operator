/**
 * Tool catalogue and direct-invoke dispatcher.
 *
 * The catalogue is the authoritative list of tools the agent loop is
 * allowed to call. Each entry declares its risk level (low / medium /
 * high / critical) — the orchestrator pauses for an approval row on
 * medium+ before running the tool.
 *
 * Tier 1 ships fifteen deterministic tools: file ops (sandboxed), memory
 * ops, browser stubs, an Ollama chat shim, plus utility tools that are
 * useful inside agent plans (uuid, clock, echo) without needing network
 * or disk access.
 *
 * `invokeTool()` is the single entry-point — never call a tool handler
 * directly. The dispatcher records timing and forwards through the
 * tenant context so every handler can audit its own work.
 */
import { randomUUID } from "node:crypto";

import {
  buildPage,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import * as browserService from "./browser.service";
import { createEvent as createCalendarEvent } from "./comm/calendar.service";
import { createDraft, sendDraft } from "./comm/email.service";
import { placeCall as placeVoipCall } from "./comm/voip.service";
import * as desktopInputService from "./desktop-input.service";
import * as filesService from "./files.service";
import * as mediaService from "./media.service";
import * as memoryService from "./memory.service";
import { chat as ollamaChat } from "./ollama.service";
import { logPrivacyEvent } from "./privacy.service";

export type ToolRiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolDescriptor {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
}

export interface ToolInvokeResult {
  toolName: string;
  output: Record<string, unknown>;
  durationMs: number;
}

type ToolHandler = (
  ctx: TenantContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface ToolEntry extends ToolDescriptor {
  handler: ToolHandler;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolValidationError(`Field "${field}" must be a non-empty string`);
  }
  return v;
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
}

export class ToolNotFoundError extends Error {
  override readonly name = "ToolNotFoundError";
  readonly code = "TOOL_NOT_FOUND";
  constructor(name: string) {
    super(`Unknown tool "${name}"`);
  }
}

export class ToolValidationError extends Error {
  override readonly name = "ToolValidationError";
  readonly code = "TOOL_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

const TOOLS: ToolEntry[] = [
  {
    name: "file.read",
    description: "Read a UTF-8 file inside the workspace sandbox.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const r = await filesService.readFile(ctx, str(input["path"], "path"));
      return { ...r };
    },
  },
  {
    name: "file.write",
    description: "Write a UTF-8 file inside the workspace sandbox.",
    riskLevel: "medium",
    handler: async (ctx, input) => {
      const r = await filesService.writeFile(
        ctx,
        str(input["path"], "path"),
        str(input["content"], "content"),
      );
      return { ...r };
    },
  },
  {
    name: "file.delete",
    description: "Delete a file inside the workspace sandbox.",
    riskLevel: "high",
    handler: async (ctx, input) => {
      const r = await filesService.deleteFile(ctx, str(input["path"], "path"));
      return { ...r };
    },
  },
  {
    name: "file.list",
    description: "List entries inside a workspace directory (paginated).",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const r = await filesService.listFiles(ctx, {
        path: typeof input["path"] === "string" ? (input["path"] as string) : ".",
        limit: intOr(input["limit"], 20),
      });
      return { items: r.items, nextCursor: r.nextCursor };
    },
  },
  {
    name: "memory.create",
    description: "Persist a long-lived user memory.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const r = await memoryService.createMemory(ctx, {
        title: str(input["title"], "title"),
        content: str(input["content"], "content"),
        kind: typeof input["kind"] === "string" ? (input["kind"] as string) : undefined,
        importance: intOr(input["importance"], 50),
      });
      return { ...r };
    },
  },
  {
    name: "memory.list",
    description: "List the user's memories ordered by importance.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const r = await memoryService.listMemories(ctx, { limit: intOr(input["limit"], 20) });
      return { items: r.items, nextCursor: r.nextCursor };
    },
  },
  {
    name: "memory.delete",
    description: "Delete one memory entry.",
    riskLevel: "high",
    handler: async (ctx, input) => {
      const r = await memoryService.deleteMemory(ctx, str(input["id"], "id"));
      return { ...r };
    },
  },
  {
    name: "browser.screenshot",
    description: "Capture a screenshot of a URL (Tier 1 stub).",
    riskLevel: "medium",
    handler: async (ctx, input) => {
      const r = await browserService.screenshot(
        ctx,
        str(input["url"], "url"),
        typeof input["viewport"] === "string" ? (input["viewport"] as string) : undefined,
      );
      return { ...r };
    },
  },
  {
    name: "browser.extract",
    description: "Extract content matching a selector (Tier 1 stub).",
    riskLevel: "medium",
    handler: async (ctx, input) => {
      const r = await browserService.extract(
        ctx,
        str(input["url"], "url"),
        str(input["selector"], "selector"),
      );
      return { ...r };
    },
  },
  {
    name: "ollama.chat",
    description: "Single-turn chat completion against the local Ollama model.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const messages = Array.isArray(input["messages"]) ? input["messages"] : [];
      const r = await ollamaChat(ctx, {
        model: typeof input["model"] === "string" ? (input["model"] as string) : "llama3",
        messages: messages as Array<{
          role: "system" | "user" | "assistant" | "tool";
          content: string;
        }>,
        temperature:
          typeof input["temperature"] === "number"
            ? (input["temperature"] as number)
            : undefined,
      });
      return { ...r };
    },
  },
  {
    name: "privacy.log",
    description: "Manually append a privacy-event row.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const r = await logPrivacyEvent(ctx, {
        eventType: str(input["eventType"], "eventType"),
        actor: str(input["actor"], "actor"),
        target: str(input["target"], "target"),
        severity:
          typeof input["severity"] === "string"
            ? (input["severity"] as
                | "info"
                | "low"
                | "medium"
                | "high"
                | "critical")
            : "info",
        detail:
          typeof input["detail"] === "string" ? (input["detail"] as string) : undefined,
      });
      return { event: r };
    },
  },
  {
    name: "clock.now",
    description: "Return the current ISO-8601 timestamp (deterministic per call).",
    riskLevel: "low",
    handler: async () => ({ now: new Date().toISOString() }),
  },
  {
    name: "random.uuid",
    description: "Generate a cryptographically-random UUID v4.",
    riskLevel: "low",
    handler: async () => ({ uuid: randomUUID() }),
  },
  {
    name: "echo",
    description: "Return the input verbatim — used by the verifier to assert wiring.",
    riskLevel: "low",
    handler: async (_ctx, input) => ({ echoed: input }),
  },
  {
    name: "noop",
    description: "Do nothing successfully — useful for plan placeholders.",
    riskLevel: "low",
    handler: async () => ({ ok: true }),
  },
  // ─── Desktop control (Tier 1 stub adapter) ─────────────────────────────────
  {
    name: "desktop.screenshot",
    description: "Capture a screenshot of the active display.",
    riskLevel: "medium",
    handler: async (ctx) => ({ ...(await desktopInputService.captureScreenshot(ctx)) }),
  },
  {
    name: "desktop.find_element",
    description: "Resolve a SEMANTIC target description to a screen element.",
    riskLevel: "low",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.resolveTarget(ctx, {
        description: str(input["description"], "description"),
        role: typeof input["role"] === "string" ? (input["role"] as string) : undefined,
        label: typeof input["label"] === "string" ? (input["label"] as string) : undefined,
      })),
    }),
  },
  {
    name: "desktop.click",
    description: "Click an element described semantically (no coordinates).",
    riskLevel: "medium",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.clickTarget(ctx, {
        description: str(input["description"], "description"),
        role: typeof input["role"] === "string" ? (input["role"] as string) : undefined,
        label: typeof input["label"] === "string" ? (input["label"] as string) : undefined,
      })),
    }),
  },
  {
    name: "desktop.type_text",
    description: "Type text into the focused control.",
    riskLevel: "high",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.typeText(ctx, str(input["text"], "text"))),
    }),
  },
  {
    name: "desktop.press_key",
    description: "Press a single keyboard key by name (e.g. Enter, Tab).",
    riskLevel: "medium",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.pressKey(ctx, str(input["key"], "key"))),
    }),
  },
  {
    name: "desktop.open_application",
    description: "Launch a desktop application by name.",
    riskLevel: "high",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.openApplication(ctx, str(input["name"], "name"))),
    }),
  },
  {
    name: "desktop.scroll",
    description: "Scroll the focused window in a direction.",
    riskLevel: "low",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.scroll(
        ctx,
        (typeof input["direction"] === "string"
          ? (input["direction"] as "up" | "down" | "left" | "right")
          : "down"),
        intOr(input["amount"], 3),
      )),
    }),
  },
  {
    name: "desktop.drag_drop",
    description: "Drag from one semantic target to another.",
    riskLevel: "high",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.dragDrop(
        ctx,
        { description: str(input["from"], "from") },
        { description: str(input["to"], "to") },
      )),
    }),
  },
  {
    name: "desktop.read_text",
    description: "Read on-screen text matching a hint (vision OCR).",
    riskLevel: "low",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.readScreenText(ctx, str(input["hint"], "hint"))),
    }),
  },
  {
    name: "desktop.terminal",
    description: "Run a terminal command on the user's machine (highest risk).",
    riskLevel: "critical",
    handler: async (ctx, input) => ({
      ...(await desktopInputService.runTerminalCommand(ctx, str(input["command"], "command"))),
    }),
  },
  {
    name: "desktop.feature_status",
    description: "Report whether desktop control is enabled and the adapter mode.",
    riskLevel: "low",
    handler: async () => {
      const status = desktopInputService.probeAdapter();
      return { available: status.available, mode: status.mode, reason: status.reason };
    },
  },
  // ─── Local media generation (Tier 1 deterministic stubs) ───────────────────
  {
    name: "media.image.generate",
    description: "Generate an image from a text prompt and save it to the media library.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const asset = await mediaService.generateImage(ctx, {
        prompt: str(input["prompt"], "prompt"),
        style:
          typeof input["style"] === "string" ? (input["style"] as string) : undefined,
        width: typeof input["width"] === "number" ? (input["width"] as number) : undefined,
        height:
          typeof input["height"] === "number" ? (input["height"] as number) : undefined,
      });
      return { ...asset };
    },
  },
  {
    name: "media.audio.generate",
    description:
      "Generate audio (music / TTS / SFX) from a text prompt and save it to the media library.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const asset = await mediaService.generateAudio(ctx, {
        prompt: str(input["prompt"], "prompt"),
        kind:
          typeof input["kind"] === "string"
            ? (input["kind"] as "music" | "tts" | "sfx")
            : undefined,
        durationMs:
          typeof input["durationMs"] === "number"
            ? (input["durationMs"] as number)
            : undefined,
      });
      return { ...asset };
    },
  },
  {
    name: "media.video.generate",
    description: "Generate a short animated video from a text prompt.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const asset = await mediaService.generateVideo(ctx, {
        prompt: str(input["prompt"], "prompt"),
        durationMs:
          typeof input["durationMs"] === "number"
            ? (input["durationMs"] as number)
            : undefined,
        sourceAssetId:
          typeof input["sourceAssetId"] === "string"
            ? (input["sourceAssetId"] as string)
            : undefined,
      });
      return { ...asset };
    },
  },
  {
    name: "media.image.upscale",
    description: "Upscale an existing image asset by 2x or 4x.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const asset = await mediaService.upscaleImage(
        ctx,
        str(input["id"], "id"),
        {
          scale: input["scale"] === 4 ? 4 : 2,
        },
      );
      return { ...asset };
    },
  },
  {
    name: "media.image.removeBackground",
    description: "Produce a transparent-background variant of an image asset.",
    riskLevel: "low",
    handler: async (ctx, input) => {
      const asset = await mediaService.removeBackground(
        ctx,
        str(input["id"], "id"),
      );
      return { ...asset };
    },
  },
  {
    name: "comm.email.send",
    description:
      "Compose and send an email through a connected account. Creates a draft, then sends it (writes a privacy event).",
    riskLevel: "medium",
    handler: async (ctx, input) => {
      const toRaw = input["to"];
      const toAddresses = Array.isArray(toRaw)
        ? toRaw
            .filter((v): v is string => typeof v === "string" && v.length > 0)
        : typeof toRaw === "string" && toRaw.length > 0
          ? [toRaw]
          : [];
      if (toAddresses.length === 0) {
        throw new ToolValidationError(`Field "to" must be a non-empty string or array`);
      }
      const draft = await createDraft(ctx, {
        accountId: str(input["accountId"], "accountId"),
        toAddresses,
        subject: str(input["subject"], "subject"),
        body: str(input["body"], "body"),
        replyToMessageId:
          typeof input["replyToMessageId"] === "string"
            ? (input["replyToMessageId"] as string)
            : undefined,
      });
      const sent = await sendDraft(ctx, draft.id);
      return { draftId: draft.id, message: sent };
    },
  },
  {
    name: "comm.calendar.create_event",
    description: "Create a calendar event on a connected calendar account.",
    riskLevel: "medium",
    handler: async (ctx, input) => {
      const attendeesRaw = input["attendees"];
      const attendees = Array.isArray(attendeesRaw)
        ? (attendeesRaw as Array<Record<string, unknown>>)
            .filter((a) => a && typeof a === "object" && typeof a["email"] === "string")
            .map((a) => ({
              email: a["email"] as string,
              name: typeof a["name"] === "string" ? (a["name"] as string) : undefined,
              response:
                typeof a["response"] === "string"
                  ? (a["response"] as
                      | "accepted"
                      | "declined"
                      | "tentative"
                      | "needs_action")
                  : undefined,
            }))
        : [];
      const event = await createCalendarEvent(ctx, {
        accountId: str(input["accountId"], "accountId"),
        title: str(input["title"], "title"),
        startsAt: intOr(input["startsAt"], Date.now()),
        endsAt: intOr(input["endsAt"], Date.now() + 30 * 60 * 1000),
        description:
          typeof input["description"] === "string"
            ? (input["description"] as string)
            : undefined,
        location:
          typeof input["location"] === "string" ? (input["location"] as string) : undefined,
        attendees,
      });
      return { event };
    },
  },
  {
    name: "comm.voip.call",
    description: "Place an outbound VoIP call through a connected Twilio account.",
    riskLevel: "high",
    handler: async (ctx, input) => {
      const call = await placeVoipCall(ctx, {
        accountId: str(input["accountId"], "accountId"),
        toNumber: str(input["toNumber"], "toNumber"),
        contactId:
          typeof input["contactId"] === "string"
            ? (input["contactId"] as string)
            : undefined,
      });
      return { call };
    },
  },
];

export function getToolDescriptors(): ToolDescriptor[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    riskLevel: t.riskLevel,
  }));
}

export function getToolByName(name: string): ToolEntry | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

export async function listTools(opts: {
  cursor?: string;
  limit?: number;
}): Promise<PaginatedData<ToolDescriptor>> {
  const limit = normaliseLimit(opts.limit);
  const all = getToolDescriptors().sort((a, b) => a.name.localeCompare(b.name));
  const cursorName = opts.cursor ? decodeCursor(opts.cursor) : null;
  const startIdx = cursorName ? all.findIndex((t) => t.name > cursorName) : 0;
  const sliced = startIdx === -1 ? [] : all.slice(startIdx);
  return buildPage(sliced.slice(0, limit + 1), limit, (t) => t.name);
}

export async function invokeTool(
  ctx: TenantContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolInvokeResult> {
  const entry = getToolByName(name);
  if (!entry) throw new ToolNotFoundError(name);
  const t0 = Date.now();
  const output = await entry.handler(ctx, input);
  return { toolName: name, output, durationMs: Date.now() - t0 };
}
