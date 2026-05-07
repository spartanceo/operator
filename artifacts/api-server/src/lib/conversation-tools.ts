/**
 * Shared tool-dispatch helpers for conversation-mode chat.
 *
 * Both the streaming and non-streaming chat routes use these to:
 *  - Inject structured tool prompt instructions into the system message so
 *    the model knows which tools are available and how to call them.
 *  - Parse a model response to detect a tool-call JSON envelope.
 *
 * The pattern is a simple JSON envelope already established for web_search:
 *   {"__tool_call__":{"name":"<tool>","arguments":{…}}}
 *
 * Context-summarisation calls (context.service.ts) do NOT use this module —
 * tool prompts must never appear in internal completion calls.
 */

// ---------------------------------------------------------------------------
// Tool prompt strings
// ---------------------------------------------------------------------------

export const WEB_SEARCH_TOOL_MSG =
  "You have access to a real-time web search tool.\n" +
  "When the user asks you to search for something, or when you need current\n" +
  "information to answer accurately, reply with ONLY the following JSON\n" +
  "(no markdown fences, no other text):\n" +
  '{"__tool_call__":{"name":"web_search","arguments":{"query":"<your search query>","count":5}}}\n' +
  "After receiving search results, provide a helpful, concise answer.";

export const IMAGE_GEN_TOOL_MSG =
  "You have access to an image-generation tool.\n" +
  "When the user asks you to generate, draw, or create an image, reply with ONLY\n" +
  "the following JSON (no markdown fences, no other text):\n" +
  '{"__tool_call__":{"name":"media.image.generate","arguments":{"prompt":"<image description>","style":"<optional style>","width":512,"height":512}}}\n' +
  "Omit optional fields (style, width, height) if the user did not specify them.\n" +
  "After the image is generated, confirm it was created — do not describe the image yourself.";

export const TTS_TOOL_MSG =
  "You have access to a text-to-speech (TTS) tool.\n" +
  'When the user asks you to "say", "speak", or "read aloud" something, reply with ONLY\n' +
  "the following JSON (no markdown fences, no other text):\n" +
  '{"__tool_call__":{"name":"media.audio.generate","arguments":{"prompt":"<text to speak>","kind":"tts"}}}\n' +
  "After the audio is generated, confirm it was spoken — do not repeat the text yourself.";

/** Combined block appended to the system message for every conversation turn. */
export const ALL_TOOL_PROMPTS =
  WEB_SEARCH_TOOL_MSG + "\n\n" + IMAGE_GEN_TOOL_MSG + "\n\n" + TTS_TOOL_MSG;

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

type ParsedEnvelope = {
  __tool_call__?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

function extractEnvelope(raw: string): ParsedEnvelope | null {
  try {
    return JSON.parse(raw) as ParsedEnvelope;
  } catch {
    return null;
  }
}

/**
 * Strip markdown code fences if present, then try to parse the envelope.
 */
function parseEnvelope(content: string): ParsedEnvelope | null {
  const trimmed = content.trim();

  const bare = extractEnvelope(trimmed);
  if (bare?.__tool_call__) return bare;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    const fenced = extractEnvelope(fenceMatch[1].trim());
    if (fenced?.__tool_call__) return fenced;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Per-tool parsers
// ---------------------------------------------------------------------------

export interface WebSearchArgs extends Record<string, unknown> {
  query: string;
  count: number;
}

export interface ImageGenArgs extends Record<string, unknown> {
  prompt: string;
  style?: string;
  width?: number;
  height?: number;
}

export interface AudioGenArgs extends Record<string, unknown> {
  prompt: string;
  kind: "tts" | "music" | "sfx";
}

export type ConversationToolCall =
  | { name: "web_search"; args: WebSearchArgs }
  | { name: "media.image.generate"; args: ImageGenArgs }
  | { name: "media.audio.generate"; args: AudioGenArgs };

/**
 * Try to parse any supported conversation tool call from the model's response.
 * Returns null if the content does not match any known tool envelope.
 */
export function tryParseConversationToolCall(
  content: string,
): ConversationToolCall | null {
  const envelope = parseEnvelope(content);
  if (!envelope?.__tool_call__) return null;

  const { name, arguments: args = {} } = envelope.__tool_call__;

  if (name === "web_search") {
    if (typeof args["query"] !== "string") return null;
    return {
      name: "web_search",
      args: {
        query: args["query"] as string,
        count: Math.max(
          1,
          Math.min(10, typeof args["count"] === "number" ? (args["count"] as number) : 5),
        ),
      },
    };
  }

  if (name === "media.image.generate") {
    if (typeof args["prompt"] !== "string") return null;
    return {
      name: "media.image.generate",
      args: {
        prompt: args["prompt"] as string,
        style: typeof args["style"] === "string" ? (args["style"] as string) : undefined,
        width: typeof args["width"] === "number" ? (args["width"] as number) : undefined,
        height: typeof args["height"] === "number" ? (args["height"] as number) : undefined,
      },
    };
  }

  if (name === "media.audio.generate") {
    if (typeof args["prompt"] !== "string") return null;
    const kind =
      args["kind"] === "music" || args["kind"] === "sfx" ? args["kind"] : "tts";
    return {
      name: "media.audio.generate",
      args: {
        prompt: args["prompt"] as string,
        kind,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Message-list injection helper
// ---------------------------------------------------------------------------

import type { RuntimeChatMessage } from "../services/runtime/types";

/**
 * Inject the combined tool-prompt block into the message list.
 * Appended to the existing system message if present, otherwise prepended
 * as a new system message.
 */
export function injectToolPrompts(
  messages: RuntimeChatMessage[],
): RuntimeChatMessage[] {
  if (messages.length > 0 && messages[0].role === "system") {
    return [
      { role: "system", content: messages[0].content + "\n\n" + ALL_TOOL_PROMPTS },
      ...messages.slice(1),
    ];
  }
  return [{ role: "system", content: ALL_TOOL_PROMPTS }, ...messages];
}
