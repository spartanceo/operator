/**
 * Skill-draft service — backbone of the no-code Skill Creator wizard.
 *
 * Three entry paths feed a single draft pipeline:
 *   1. Upload  — extract text from PDF/EPUB/DOCX/TXT/MD, ask the local
 *                LLM to structure it into a skill draft.
 *   2. Paste   — same as upload but the user supplies raw text directly.
 *   3. Interview — the local LLM walks the user through 5–7 plain-language
 *                questions; the answers become the draft.
 *
 * Every LLM call goes through `ollama.service.chat`, which itself logs a
 * privacy event for every outbound request. When Ollama is unreachable
 * we degrade to a deterministic heuristic so the wizard remains usable
 * in Tier 1 environments and in tests.
 *
 * Drafts never leave the local tenant. Publishing the draft is a
 * separate, explicit step (see `store.service.ts` → `publishDraft`).
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  skillDrafts,
  tenantScope,
  withTenantValues,
  type PaginatedData,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { chat as ollamaChat } from "./ollama.service";
import { logPrivacyEvent } from "./privacy.service";

export type DraftSource = "upload" | "paste" | "interview";
export type DraftStatus = "draft" | "ready" | "published";

export interface SkillDraftRow {
  id: string;
  source: DraftSource;
  status: DraftStatus;
  rawInput: string;
  interviewTranscript: InterviewTurn[];
  interviewStep: number;
  name: string;
  description: string;
  content: string;
  modelTags: string[];
  triggers: string[];
  examplePrompts: string[];
  category: string;
  skillId: string | null;
  publishedStoreSkillId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewTurn {
  role: "system" | "assistant" | "user";
  content: string;
}

export class DraftNotFoundError extends Error {
  override readonly name = "DraftNotFoundError";
  readonly code = "DRAFT_NOT_FOUND";
  constructor(id: string) {
    super(`Unknown draft "${id}"`);
  }
}

export class DraftValidationError extends Error {
  override readonly name = "DraftValidationError";
  readonly code = "DRAFT_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

// tier-review: bounded — 7 fixed prompts, never mutated at runtime.
export const INTERVIEW_QUESTIONS: readonly string[] = [
  "In one sentence, what are you an expert in?",
  "Who is this skill for? Describe the typical user.",
  "What three questions should this skill answer best?",
  "What are the key principles or rules the skill should always follow?",
  "What should this skill never do, suggest, or recommend?",
  "What tone of voice should it use? (e.g. friendly coach, terse technical, formal advisor)",
  "If someone uses this skill once, what should they walk away with?",
];

export const MAX_RAW_INPUT_BYTES = 1_500_000; // ~1.5MB after extraction
export const MAX_DRAFT_CONTENT_CHARS = 64_000;

function parseStringArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function parseTranscript(raw: string): InterviewTurn[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is InterviewTurn =>
        typeof v === "object" &&
        v !== null &&
        typeof v.content === "string" &&
        (v.role === "user" || v.role === "assistant" || v.role === "system"),
    );
  } catch {
    return [];
  }
}

function toRow(r: typeof skillDrafts.$inferSelect): SkillDraftRow {
  return {
    id: r.id,
    source: r.source as DraftSource,
    status: r.status as DraftStatus,
    rawInput: r.rawInput,
    interviewTranscript: parseTranscript(r.interviewTranscript),
    interviewStep: r.interviewStep,
    name: r.name,
    description: r.description,
    content: r.content,
    modelTags: parseStringArray(r.modelTags),
    triggers: parseStringArray(r.triggers),
    examplePrompts: parseStringArray(r.examplePrompts),
    category: r.category,
    skillId: r.skillId,
    publishedStoreSkillId: r.publishedStoreSkillId,
    version: r.version,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/**
 * Best-effort plaintext extractor for the Upload path.
 *
 * `kind` is the file extension or mime hint the client sent. For Tier 1
 * we accept the four text-shaped formats directly (TXT, MD, EPUB-as-text,
 * DOCX-as-text) as a base64 payload, and treat PDFs/DOCX-as-binary as
 * already-extracted text from the client side. This keeps the server free
 * of heavy parsing dependencies until Task #29 ships the binary parser
 * pipeline. Anything past `MAX_RAW_INPUT_BYTES` is truncated.
 */
export function extractText(input: {
  kind: string;
  base64?: string;
  text?: string;
}): string {
  let body = "";
  if (typeof input.text === "string") {
    body = input.text;
  } else if (typeof input.base64 === "string") {
    try {
      const buf = Buffer.from(input.base64, "base64");
      // For text/markdown we decode UTF-8; for binary types we strip
      // anything that isn't printable ASCII so the LLM gets *something*
      // useful when a real binary parser isn't wired yet.
      const decoded = buf.toString("utf8");
      if (input.kind === "txt" || input.kind === "md" || input.kind === "markdown" || input.kind === "text") {
        body = decoded;
      } else {
        // Strip non-printable / non-newline bytes — keeps Latin chars + punctuation.
        body = decoded.replace(/[^\x20-\x7E\n\r\t\u00A0-\uFFFF]/g, " ");
      }
    } catch (e) {
      logger.warn({ err: e, kind: input.kind }, "Failed to decode base64 upload");
    }
  }
  // Collapse runs of whitespace and cap length.
  body = body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length > MAX_RAW_INPUT_BYTES) body = body.slice(0, MAX_RAW_INPUT_BYTES);
  return body;
}

interface DraftFields {
  name: string;
  description: string;
  content: string;
  modelTags: string[];
  triggers: string[];
  examplePrompts: string[];
  category: string;
}

const DEFAULT_MODEL_TAGS: readonly string[] = ["llama3.1", "qwen2.5", "mistral"];
const KNOWN_CATEGORIES: readonly string[] = [
  "Productivity",
  "Sales",
  "Creative",
  "Coding",
  "Research",
  "Communication",
  "Finance",
  "Legal",
  "Medical",
  "Education",
];

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + "…";
}

function deterministicDraftFromText(raw: string, hint?: string): DraftFields {
  const trimmed = raw.trim();
  const firstLine = trimmed.split(/\n/, 1)[0]?.trim() ?? "";
  const titleSeed = firstLine.length > 0 ? firstLine : (hint ?? "Untitled Skill");
  const name = clamp(titleSeed.replace(/[#*_>`]/g, "").trim(), 80) || "Untitled Skill";
  const summary =
    trimmed.length > 0
      ? clamp(trimmed.replace(/\s+/g, " "), 280)
      : "A skill drafted from your content.";
  const description = clamp(summary, 280);

  // Pick a category by keyword hits (deterministic — no ML).
  const lower = trimmed.toLowerCase();
  const category =
    KNOWN_CATEGORIES.find((c) => lower.includes(c.toLowerCase())) ?? "Productivity";

  const examplePrompts = [
    `What does ${name.toLowerCase()} cover?`,
    `Give me a quick summary using ${name.toLowerCase()}.`,
    `Apply ${name.toLowerCase()} to a real-world example.`,
  ];

  const triggers = Array.from(
    new Set(
      [
        name.toLowerCase(),
        ...name.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
      ].filter((t) => t.length > 2),
    ),
  ).slice(0, 6);

  const content = `You are a skill called "${name}".\n\nWhat you know:\n${clamp(trimmed, MAX_DRAFT_CONTENT_CHARS - 400)}\n\nHow to answer:\n- Be precise and use the source material above.\n- If asked something out of scope, say so plainly.\n- Cite the part of the material that supports your answer when relevant.`;

  return {
    name,
    description,
    content,
    modelTags: [...DEFAULT_MODEL_TAGS],
    triggers,
    examplePrompts,
    category,
  };
}

/**
 * Ask the local LLM to structure raw text into a skill draft.
 *
 * Returns a `DraftFields` object even when Ollama is unreachable — the
 * deterministic fallback keeps the wizard usable everywhere.
 */
async function structureWithLocalModel(
  ctx: TenantContext,
  rawText: string,
  hint?: string,
): Promise<DraftFields> {
  if (!rawText.trim()) {
    return deterministicDraftFromText("", hint);
  }
  const sample = rawText.length > 8_000 ? rawText.slice(0, 8_000) : rawText;
  const system = [
    "You are a no-code skill builder for the Omninity Operator.",
    "Read the user's source material and propose a single skill JSON object.",
    'Respond ONLY with JSON of the form: {"name":"","description":"","content":"","triggers":[],"examplePrompts":[],"category":""}',
    "name: under 80 chars. description: under 280 chars. content: a system prompt the agent will use.",
    "triggers: 3-6 short trigger phrases the user might type that should fire this skill.",
    "examplePrompts: 3 short example questions a user could try.",
    `category: one of ${KNOWN_CATEGORIES.join(", ")}.`,
  ].join("\n");
  const result = await ollamaChat(ctx, {
    model: "llama3.1",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: sample },
    ],
  });
  const parsed = tryParseSkillJson(result.message.content);
  if (parsed) {
    return {
      ...deterministicDraftFromText(rawText, hint),
      ...parsed,
      modelTags: parsed.modelTags ?? [...DEFAULT_MODEL_TAGS],
    };
  }
  return deterministicDraftFromText(rawText, hint);
}

function tryParseSkillJson(s: string): Partial<DraftFields> | null {
  if (!s) return null;
  // The local model might wrap JSON in markdown fences or prose; pull the first {...}.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const out: Partial<DraftFields> = {};
    if (typeof obj["name"] === "string") out.name = clamp(obj["name"], 80);
    if (typeof obj["description"] === "string") out.description = clamp(obj["description"], 280);
    if (typeof obj["content"] === "string") out.content = clamp(obj["content"], MAX_DRAFT_CONTENT_CHARS);
    if (Array.isArray(obj["triggers"])) {
      out.triggers = obj["triggers"]
        .filter((v): v is string => typeof v === "string")
        .slice(0, 8);
    }
    if (Array.isArray(obj["examplePrompts"])) {
      out.examplePrompts = obj["examplePrompts"]
        .filter((v): v is string => typeof v === "string")
        .slice(0, 6);
    }
    if (typeof obj["category"] === "string") out.category = obj["category"];
    return out;
  } catch {
    return null;
  }
}

async function persistDraft(
  ctx: TenantContext,
  base: {
    source: DraftSource;
    rawInput: string;
    interviewTranscript?: InterviewTurn[];
    interviewStep?: number;
    fields: DraftFields;
  },
): Promise<SkillDraftRow> {
  const id = `draft_${nanoid()}`;
  await db.insert(skillDrafts).values(
    withTenantValues(ctx, {
      id,
      source: base.source,
      status: "draft",
      rawInput: base.rawInput.slice(0, MAX_RAW_INPUT_BYTES),
      interviewTranscript: JSON.stringify(base.interviewTranscript ?? []),
      interviewStep: base.interviewStep ?? 0,
      name: base.fields.name,
      description: base.fields.description,
      content: base.fields.content,
      modelTags: JSON.stringify(base.fields.modelTags),
      triggers: JSON.stringify(base.fields.triggers),
      examplePrompts: JSON.stringify(base.fields.examplePrompts),
      category: base.fields.category,
    }),
  );
  await logPrivacyEvent(ctx, {
    eventType: "skill.draft.create",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `source=${base.source}`,
  });
  const row = await getDraft(ctx, id);
  if (!row) throw new Error("Draft vanished after creation");
  return row;
}

export interface CreateUploadDraftInput {
  fileName: string;
  kind: string;
  base64?: string;
  text?: string;
}

export async function createDraftFromUpload(
  ctx: TenantContext,
  input: CreateUploadDraftInput,
): Promise<SkillDraftRow> {
  const supported = ["pdf", "epub", "docx", "txt", "md", "markdown", "text"];
  if (!supported.includes(input.kind.toLowerCase())) {
    throw new DraftValidationError(
      `Unsupported file kind "${input.kind}". Accepted: ${supported.join(", ")}`,
    );
  }
  const raw = extractText(input);
  if (raw.length < 20) {
    throw new DraftValidationError(
      "Could not extract enough text from this file. Try a different export or the Paste path.",
    );
  }
  const fields = await structureWithLocalModel(ctx, raw, input.fileName);
  return persistDraft(ctx, { source: "upload", rawInput: raw, fields });
}

export async function createDraftFromPaste(
  ctx: TenantContext,
  text: string,
): Promise<SkillDraftRow> {
  const raw = text.trim();
  if (raw.length < 20) {
    throw new DraftValidationError(
      "Paste at least a few sentences so the local model has something to work with.",
    );
  }
  const fields = await structureWithLocalModel(ctx, raw);
  return persistDraft(ctx, { source: "paste", rawInput: raw, fields });
}

export async function startInterviewDraft(ctx: TenantContext): Promise<SkillDraftRow> {
  const fields = deterministicDraftFromText("");
  const transcript: InterviewTurn[] = [
    { role: "assistant", content: INTERVIEW_QUESTIONS[0] ?? "Tell me about your skill." },
  ];
  return persistDraft(ctx, {
    source: "interview",
    rawInput: "",
    interviewTranscript: transcript,
    interviewStep: 0,
    fields,
  });
}

export async function answerInterview(
  ctx: TenantContext,
  draftId: string,
  answer: string,
): Promise<SkillDraftRow> {
  const existing = await getDraft(ctx, draftId);
  if (!existing) throw new DraftNotFoundError(draftId);
  if (existing.source !== "interview") {
    throw new DraftValidationError("Draft was not created in interview mode");
  }
  if (existing.status === "published") {
    throw new DraftValidationError("Cannot answer interview on a published draft");
  }
  const trimmed = answer.trim();
  if (!trimmed) {
    throw new DraftValidationError("Interview answer is empty");
  }
  const transcript: InterviewTurn[] = [
    ...existing.interviewTranscript,
    { role: "user", content: clamp(trimmed, 4_000) },
  ];
  const nextStep = existing.interviewStep + 1;
  const finished = nextStep >= INTERVIEW_QUESTIONS.length;
  if (!finished) {
    transcript.push({
      role: "assistant",
      content: INTERVIEW_QUESTIONS[nextStep] ?? "Anything else you want to add?",
    });
  }

  let patch: Partial<typeof skillDrafts.$inferInsert> = {
    interviewTranscript: JSON.stringify(transcript),
    interviewStep: nextStep,
    updatedAt: Date.now(),
    version: existing.version + 1,
  };

  if (finished) {
    // Roll the answers up into a draft via the local model.
    const userTurns = transcript.filter((t) => t.role === "user").map((t) => t.content);
    const synthetic = INTERVIEW_QUESTIONS.map((q, i) => `Q: ${q}\nA: ${userTurns[i] ?? ""}`).join("\n\n");
    const fields = await structureWithLocalModel(ctx, synthetic, userTurns[0]);
    patch = {
      ...patch,
      name: fields.name,
      description: fields.description,
      content: fields.content,
      modelTags: JSON.stringify(fields.modelTags),
      triggers: JSON.stringify(fields.triggers),
      examplePrompts: JSON.stringify(fields.examplePrompts),
      category: fields.category,
      status: "ready",
    };
  }

  await db
    .update(skillDrafts)
    .set(patch)
    .where(
      and(
        tenantScope(ctx, skillDrafts),
        eq(skillDrafts.id, draftId),
        eq(skillDrafts.version, existing.version),
      ),
    );

  const row = await getDraft(ctx, draftId);
  if (!row) throw new DraftNotFoundError(draftId);
  return row;
}

export interface UpdateDraftInput {
  name?: string;
  description?: string;
  content?: string;
  modelTags?: string[];
  triggers?: string[];
  examplePrompts?: string[];
  category?: string;
}

export async function updateDraft(
  ctx: TenantContext,
  id: string,
  input: UpdateDraftInput,
): Promise<SkillDraftRow> {
  const existing = await getDraft(ctx, id);
  if (!existing) throw new DraftNotFoundError(id);
  if (existing.status === "published") {
    throw new DraftValidationError("Published drafts are read-only");
  }
  const patch: Partial<typeof skillDrafts.$inferInsert> = {
    updatedAt: Date.now(),
    version: existing.version + 1,
  };
  if (input.name !== undefined) patch.name = clamp(input.name.trim(), 200);
  if (input.description !== undefined) patch.description = clamp(input.description.trim(), 2_000);
  if (input.content !== undefined) patch.content = clamp(input.content, MAX_DRAFT_CONTENT_CHARS);
  if (input.modelTags !== undefined) patch.modelTags = JSON.stringify(input.modelTags.slice(0, 20));
  if (input.triggers !== undefined) patch.triggers = JSON.stringify(input.triggers.slice(0, 20));
  if (input.examplePrompts !== undefined) {
    patch.examplePrompts = JSON.stringify(input.examplePrompts.slice(0, 10));
  }
  if (input.category !== undefined) patch.category = input.category;
  // Mark as `ready` once the draft has a name + content the user touched.
  if ((patch.name || existing.name) && (patch.content || existing.content)) {
    patch.status = "ready";
  }
  await db
    .update(skillDrafts)
    .set(patch)
    .where(
      and(
        tenantScope(ctx, skillDrafts),
        eq(skillDrafts.id, id),
        eq(skillDrafts.version, existing.version),
      ),
    );
  const row = await getDraft(ctx, id);
  if (!row) throw new DraftNotFoundError(id);
  return row;
}

export async function getDraft(
  ctx: TenantContext,
  id: string,
): Promise<SkillDraftRow | null> {
  const rows = await db
    .select()
    .from(skillDrafts)
    .where(and(tenantScope(ctx, skillDrafts), eq(skillDrafts.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export interface ListDraftsOptions {
  cursor?: string;
  limit?: number;
}

export async function listDrafts(
  ctx: TenantContext,
  opts: ListDraftsOptions = {},
): Promise<PaginatedData<SkillDraftRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const filters: ReturnType<typeof and>[] = [];
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    filters.push(lt(skillDrafts.createdAt, cursorTs));
  }
  const where =
    filters.length > 0
      ? and(tenantScope(ctx, skillDrafts), ...filters)
      : tenantScope(ctx, skillDrafts);
  const rows = await db
    .select()
    .from(skillDrafts)
    .where(where)
    .orderBy(desc(skillDrafts.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function deleteDraft(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getDraft(ctx, id);
  if (!existing) return { id, deleted: false };
  await db
    .delete(skillDrafts)
    .where(and(tenantScope(ctx, skillDrafts), eq(skillDrafts.id, id)));
  return { id, deleted: true };
}

/**
 * Run the draft against the local model with a sample message — the
 * "live tester" surface in the wizard. Returns the assistant message
 * Ollama produced (or a deterministic stub when Ollama is not available).
 */
export async function testDraft(
  ctx: TenantContext,
  draftId: string,
  input: { message: string; modelName?: string },
): Promise<{ model: string; reply: string }> {
  const existing = await getDraft(ctx, draftId);
  if (!existing) throw new DraftNotFoundError(draftId);
  const model = input.modelName?.trim() || existing.modelTags[0] || "llama3.1";
  const messages = [
    { role: "system" as const, content: existing.content || existing.name },
    { role: "user" as const, content: clamp(input.message, 4_000) },
  ];
  const result = await ollamaChat(ctx, { model, messages, temperature: 0.2 });
  await logPrivacyEvent(ctx, {
    eventType: "skill.draft.test",
    actor: ctx.userId ?? ctx.tenantId,
    target: draftId,
    severity: "low",
    detail: `model=${model}`,
  });
  return { model: result.model, reply: result.message.content };
}

/** Mark a draft `published` and record which store row it produced. */
export async function markDraftPublished(
  ctx: TenantContext,
  draftId: string,
  storeSkillId: string,
): Promise<SkillDraftRow> {
  const existing = await getDraft(ctx, draftId);
  if (!existing) throw new DraftNotFoundError(draftId);
  await db
    .update(skillDrafts)
    .set({
      status: "published",
      publishedStoreSkillId: storeSkillId,
      updatedAt: Date.now(),
      version: existing.version + 1,
    })
    .where(
      and(
        tenantScope(ctx, skillDrafts),
        eq(skillDrafts.id, draftId),
        eq(skillDrafts.version, existing.version),
      ),
    );
  const row = await getDraft(ctx, draftId);
  if (!row) throw new DraftNotFoundError(draftId);
  return row;
}
