/**
 * Personal Knowledge Base service — Tier 1 implementation.
 *
 * Why this exists:
 *   The OMNINITY context (Section 2) names `nomic-embed-text` + `sqlite-vec`
 *   as the eventual embedding stack. Tier 1 ships a deterministic local
 *   replacement that satisfies the contract (`embed(text) -> number[]`,
 *   cosine similarity) without bringing up Ollama or shipping the sqlite-vec
 *   binary, mirroring the same Tier-1 stub strategy used in
 *   `agent.service.ts`.
 *
 * Embedding model:
 *   Bag-of-words hash projected into a fixed `EMBED_DIM` float vector,
 *   sublinear-TF weighted, then L2-normalised so dot product == cosine
 *   similarity. Two semantically similar paragraphs share token overlap →
 *   their vectors agree on more buckets → higher cosine. The vectors are
 *   reproducible byte-for-byte (FNV-1a 32-bit hash) so test cases can
 *   assert exact ranking results.
 *
 * Search:
 *   Hybrid score = 0.6 * cosine + 0.4 * keyword overlap. Keyword score is
 *   a Jaccard-style overlap on tokenised query/chunk so the rank stays
 *   sensible even when the query has a single rare term that the
 *   bag-of-words embedding alone can't surface.
 *
 * Tenant safety:
 *   Every read goes through `tenantScope` and every write through
 *   `withTenantValues`. URL ingestion is wrapped in `logPrivacyEvent`
 *   per Standard 12.
 */
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import { isIP } from "node:net";

import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  kbChunks,
  kbCollections,
  kbDocuments,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";
import { withTimeout, TIMEOUTS } from "@workspace/errors";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

// ─── Types ───────────────────────────────────────────────────────────────────

export type KbSourceType = "text" | "url" | "file" | "youtube";

export interface KbCollectionRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KbDocumentRow {
  id: string;
  collectionId: string | null;
  title: string;
  sourceType: string;
  sourceUri: string | null;
  mimeType: string | null;
  contentHash: string;
  sizeBytes: number;
  chunkCount: number;
  summary: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KbChunkSummary {
  id: string;
  position: number;
  text: string;
  tokens: number;
}

export interface KbDocumentDetail {
  document: KbDocumentRow;
  body: string;
  chunks: KbChunkSummary[];
}

export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  position: number;
  snippet: string;
  score: number;
  vectorScore: number;
  textScore: number;
  sourceUri: string | null;
}

export interface KbStats {
  documentCount: number;
  collectionCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  lastUpdatedAt: string | null;
}

export interface IngestInput {
  sourceType: KbSourceType;
  title: string;
  body?: string;
  url?: string;
  mimeType?: string;
  collectionId?: string;
  tags?: string[];
  allowDuplicate?: boolean;
  /**
   * Internal flag used by `importSnapshot`. When true, `body` is treated as
   * the authoritative document payload regardless of `sourceType` — no URL
   * fetch, no YouTube placeholder. This is what makes import a true
   * backup-restore (works offline, immune to upstream content drift).
   */
  restoreFromSnapshot?: boolean;
}

export interface IngestResult {
  document: KbDocumentRow;
  duplicate: boolean;
  existingDocumentId: string | null;
}

export interface SearchOpts {
  query: string;
  limit?: number;
  collectionId?: string;
}

export interface KbExportDocument {
  id: string;
  collectionId?: string | null;
  title: string;
  sourceType: string;
  sourceUri?: string | null;
  mimeType?: string | null;
  body: string;
  contentHash: string;
  tags: string[];
  summary?: string | null;
  createdAt: string;
}

export interface KbExportCollection {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KbExportSnapshot {
  exportedAt: string;
  version: string;
  collections: KbExportCollection[];
  documents: KbExportDocument[];
}

export interface KbImportError {
  title: string;
  sourceDocumentId: string;
  message: string;
}

export interface KbImportResult {
  collectionsImported: number;
  documentsImported: number;
  documentsSkipped: number;
  errors: KbImportError[];
}

export class KbValidationError extends Error {
  override readonly name = "KbValidationError";
  readonly code = "KB_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

// ─── Deterministic embedding ─────────────────────────────────────────────────

const EMBED_DIM = 256;
const CHUNK_TARGET_CHARS = 800;
const CHUNK_OVERLAP_CHARS = 100;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB upper bound on a single ingest
const MAX_CHUNKS_PER_DOC = 1000;
const SNIPPET_MAX_CHARS = 320;
const URL_FETCH_MAX_BYTES = 1 * 1024 * 1024;

/** FNV-1a 32-bit hash — small, fast, deterministic, no crypto strength needed. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// tier-review: bounded — fixed 39-element English stop-word list, never grows.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "of", "to",
  "in", "on", "at", "by", "for", "with", "is", "are", "was", "were", "be",
  "been", "being", "this", "that", "these", "those", "it", "its", "as",
  "from", "into", "about", "we", "you", "i", "they", "he", "she",
]);

/**
 * Tokenise a string for the bag-of-words embedding. Lower-cased, alpha-
 * numeric runs only, stop-words removed, max length per token capped to
 * keep the loop bounded under adversarial input.
 */
function tokenise(text: string): string[] {
  const out: string[] = [];
  const lowered = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < lowered.length; i++) {
    const c = lowered.charCodeAt(i);
    const isAlphaNum =
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x61 && c <= 0x7a); // a-z
    if (isAlphaNum) {
      buf += lowered[i];
      if (buf.length > 32) buf = buf.slice(0, 32);
    } else {
      if (buf.length >= 2 && !STOP_WORDS.has(buf)) out.push(buf);
      buf = "";
    }
  }
  if (buf.length >= 2 && !STOP_WORDS.has(buf)) out.push(buf);
  return out;
}

/**
 * Project a document into a fixed-dimension L2-normalised float vector.
 * Sublinear TF weighting (1 + log(count)) reduces the influence of a single
 * repeated word, and the FNV-1a hash deterministically picks the bucket so
 * tests can assert exact rankings without seeded RNG.
 */
export function embed(text: string): number[] {
  const tokens = tokenise(text);
  if (tokens.length === 0) return new Array(EMBED_DIM).fill(0);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const [token, count] of counts) {
    const bucket = fnv1a(token) % EMBED_DIM;
    // Sign trick: half the buckets contribute negatively so opposite
    // documents don't all collide on the positive axis.
    const sign = (fnv1a(token + "_sgn") & 1) === 0 ? 1 : -1;
    const weight = 1 + Math.log(1 + count);
    v[bucket] = (v[bucket] ?? 0) + sign * weight;
  }
  // L2 normalise so cosine == dot product.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < EMBED_DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

function jaccardKeywordScore(query: string, text: string): number {
  const qSet = new Set(tokenise(query));
  if (qSet.size === 0) return 0;
  const tSet = new Set(tokenise(text));
  if (tSet.size === 0) return 0;
  let overlap = 0;
  for (const t of qSet) if (tSet.has(t)) overlap++;
  return overlap / qSet.size;
}

function approximateTokens(text: string): number {
  // Cheap heuristic — production embedders use a real tokenizer, but for
  // the chunk-budget UI a 4-chars-per-token rule is close enough.
  return Math.max(1, Math.ceil(text.length / 4));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── Body parsing & chunking ────────────────────────────────────────────────

/** Strip HTML tags + decode the small set of named entities we care about. */
function stripHtml(html: string): string {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const noStyles = noScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const noTags = noStyles.replace(/<[^>]+>/g, " ");
  return noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseBody(raw: string, mimeType: string | undefined): string {
  if (mimeType && mimeType.includes("html")) return stripHtml(raw);
  if (raw.includes("<html") || raw.includes("<body")) return stripHtml(raw);
  return raw.replace(/\r\n/g, "\n").trim();
}

function chunkText(body: string): string[] {
  if (body.length === 0) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(start + CHUNK_TARGET_CHARS, body.length);
    // Try to break on a paragraph or sentence boundary.
    if (end < body.length) {
      const lastBreak = Math.max(
        body.lastIndexOf("\n\n", end),
        body.lastIndexOf(". ", end),
      );
      if (lastBreak > start + CHUNK_TARGET_CHARS / 2) end = lastBreak + 1;
    }
    const chunk = body.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (chunks.length >= MAX_CHUNKS_PER_DOC) break;
    if (end === body.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}

// ─── URL ingest (Tier 1: text/HTML only, capped) ───────────────────────────

/**
 * SSRF guard for the KB URL ingester. Rejects:
 *   - non-http(s) schemes
 *   - loopback/link-local hostnames (`localhost`, `*.local`, `*.localhost`)
 *   - literal IPs in private / loopback / link-local / multicast / CGNAT space
 *     (both IPv4 and IPv6, including IPv4-mapped IPv6)
 *   - DNS hostnames whose A/AAAA records resolve into the same private space
 *
 * This is best-effort defence-in-depth — full DNS-rebinding resistance would
 * require resolving once and binding the connection to that exact IP. For the
 * Tier-1 single-user deployment it is sufficient to keep an unwitting paste
 * of `http://169.254.169.254/...` or `http://localhost:5432/` from hitting
 * cloud metadata services or the operator's own loopback ports.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + AWS/Azure metadata
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 ULA
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

async function assertPublicHost(parsed: URL): Promise<void> {
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new KbValidationError(
      `URL host '${host}' is not allowed (loopback / link-local)`,
    );
  }
  const literal = isIP(host);
  if (literal === 4) {
    if (isPrivateIPv4(host)) {
      throw new KbValidationError(
        `URL host '${host}' is not allowed (private IPv4 range)`,
      );
    }
    return;
  }
  if (literal === 6) {
    if (isPrivateIPv6(host)) {
      throw new KbValidationError(
        `URL host '${host}' is not allowed (private IPv6 range)`,
      );
    }
    return;
  }
  // DNS hostname — resolve and reject if any record points into private space.
  let addrs: { address: string; family: number }[] = [];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new KbValidationError(`Could not resolve URL host: ${host}`);
  }
  for (const a of addrs) {
    if (a.family === 4 && isPrivateIPv4(a.address)) {
      throw new KbValidationError(
        `URL host '${host}' resolves to a private IPv4 (${a.address})`,
      );
    }
    if (a.family === 6 && isPrivateIPv6(a.address)) {
      throw new KbValidationError(
        `URL host '${host}' resolves to a private IPv6 (${a.address})`,
      );
    }
  }
}

async function fetchUrlContent(
  ctx: TenantContext,
  url: string,
): Promise<{ body: string; mimeType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new KbValidationError(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new KbValidationError("Only http/https URLs are supported");
  }
  await assertPublicHost(parsed);
  await logPrivacyEvent(ctx, {
    eventType: "knowledge.fetch_url",
    actor: ctx.userId ?? ctx.tenantId,
    target: url,
    severity: "low",
  });
  const controller = new AbortController();
  const res = await withTimeout(
    fetch(parsed.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
        "User-Agent": "OmninityOperator/0.1 (+local-knowledge-base)",
      },
    }),
    TIMEOUTS.HTTP_DEFAULT,
    {
      operation: `kb.fetchUrl(${parsed.host})`,
      onTimeout: () => controller.abort(),
    },
  );
  if (!res.ok) {
    throw new KbValidationError(`URL fetch failed: ${res.status} ${res.statusText}`);
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "text/plain";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > URL_FETCH_MAX_BYTES) {
    throw new KbValidationError(
      `Fetched content exceeds the ${URL_FETCH_MAX_BYTES}-byte URL ingest cap`,
    );
  }
  return { body: buf.toString("utf8"), mimeType };
}

// YouTube: real transcription requires yt-dlp + Whisper (Tier 2). For now we
// treat the URL as a metadata anchor and ingest a placeholder body so the
// ingest route shape stays stable — callers can later swap in transcribed text.
function youtubePlaceholderBody(url: string): { body: string; mimeType: string } {
  const body =
    `YouTube video ingested as metadata only.\n` +
    `Source: ${url}\n\n` +
    `Local transcription via yt-dlp + Whisper is enabled in a later tier; ` +
    `until then, the URL is stored so the document is searchable by title and ` +
    `the body can be replaced with a transcript via re-ingest.`;
  return { body, mimeType: "text/plain" };
}

// ─── Row mappers ────────────────────────────────────────────────────────────

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  } catch {
    // fall through
  }
  return [];
}

function toCollectionRow(
  r: typeof kbCollections.$inferSelect,
  documentCount: number,
): KbCollectionRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    documentCount,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function toDocumentRow(r: typeof kbDocuments.$inferSelect): KbDocumentRow {
  return {
    id: r.id,
    collectionId: r.collectionId,
    title: r.title,
    sourceType: r.sourceType,
    sourceUri: r.sourceUri,
    mimeType: r.mimeType,
    contentHash: r.contentHash,
    sizeBytes: r.sizeBytes,
    chunkCount: r.chunkCount,
    summary: r.summary,
    tags: parseTags(r.tags),
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function autoSummary(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  const firstParagraph = trimmed.split(/\n\n/)[0] ?? trimmed;
  if (firstParagraph.length <= 280) return firstParagraph;
  return `${firstParagraph.slice(0, 277)}…`;
}

function autoTags(body: string, explicit: string[] | undefined): string[] {
  const tags = new Set<string>();
  for (const t of explicit ?? []) {
    const norm = t.trim().toLowerCase();
    if (norm.length > 0 && norm.length <= 80) tags.add(norm);
  }
  // Cheap auto-tagging: top-N most frequent non-stopword tokens.
  if ((explicit?.length ?? 0) === 0) {
    const counts = new Map<string, number>();
    for (const t of tokenise(body).slice(0, 5000)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const sorted = [...counts.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [t] of sorted) tags.add(t);
  }
  return [...tags];
}

// ─── Collections ────────────────────────────────────────────────────────────

export async function listCollections(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<KbCollectionRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, kbCollections);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(kbCollections.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(kbCollections)
    .where(where)
    .orderBy(desc(kbCollections.createdAt))
    .limit(limit + 1);
  const counts = await Promise.all(
    rows.map(async (r) => {
      const docs = await db
        .select()
        .from(kbDocuments)
        .where(
          and(tenantScope(ctx, kbDocuments), eq(kbDocuments.collectionId, r.id)),
        );
      return docs.length;
    }),
  );
  return buildPage(
    rows.map((r, i) => toCollectionRow(r, counts[i] ?? 0)),
    limit,
    (r) => String(new Date(r.createdAt).getTime()),
  );
}

export async function createCollection(
  ctx: TenantContext,
  input: { name: string; description?: string; color?: string },
): Promise<KbCollectionRow> {
  const id = `kbc_${nanoid()}`;
  await db.insert(kbCollections).values(
    withTenantValues(ctx, {
      id,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? null,
    }),
  );
  const row = await db
    .select()
    .from(kbCollections)
    .where(and(tenantScope(ctx, kbCollections), eq(kbCollections.id, id)))
    .limit(1);
  if (!row[0]) throw new Error("Collection vanished after insert");
  return toCollectionRow(row[0], 0);
}

export async function deleteCollection(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await db
    .select()
    .from(kbCollections)
    .where(and(tenantScope(ctx, kbCollections), eq(kbCollections.id, id)))
    .limit(1);
  if (!existing[0]) return { id, deleted: false };
  await db.transaction((tx) => {
    // Unlink documents from the collection — never silently delete them.
    tx
      .update(kbDocuments)
      .set({ collectionId: null, updatedAt: Date.now() })
      .where(
        and(tenantScope(ctx, kbDocuments), eq(kbDocuments.collectionId, id)),
      )
      .run();
    tx
      .delete(kbCollections)
      .where(and(tenantScope(ctx, kbCollections), eq(kbCollections.id, id)))
      .run();
  });
  return { id, deleted: true };
}

// ─── Documents ──────────────────────────────────────────────────────────────

export async function listDocuments(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; collectionId?: string } = {},
): Promise<PaginatedData<KbDocumentRow>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, kbDocuments);
  const conditions = [baseScope];
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(kbDocuments.createdAt, cursorTs));
  }
  if (opts.collectionId) {
    conditions.push(eq(kbDocuments.collectionId, opts.collectionId));
  }
  const rows = await db
    .select()
    .from(kbDocuments)
    .where(and(...conditions))
    .orderBy(desc(kbDocuments.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toDocumentRow), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getDocument(
  ctx: TenantContext,
  id: string,
): Promise<KbDocumentDetail | null> {
  const docRows = await db
    .select()
    .from(kbDocuments)
    .where(and(tenantScope(ctx, kbDocuments), eq(kbDocuments.id, id)))
    .limit(1);
  const doc = docRows[0];
  if (!doc) return null;
  const chunkRows = await db
    .select()
    .from(kbChunks)
    .where(and(tenantScope(ctx, kbChunks), eq(kbChunks.documentId, id)));
  chunkRows.sort((a, b) => a.position - b.position);
  return {
    document: toDocumentRow(doc),
    body: doc.body,
    chunks: chunkRows.map((c) => ({
      id: c.id,
      position: c.position,
      text: c.text,
      tokens: c.tokens,
    })),
  };
}

export async function ingestDocument(
  ctx: TenantContext,
  input: IngestInput,
): Promise<IngestResult> {
  // Resolve body + mime type per source type.
  let body: string;
  let mimeType: string | undefined = input.mimeType;
  let sourceUri: string | null = null;

  // Backup-restore path: when re-ingesting from an exported snapshot we
  // trust the snapshot body verbatim regardless of `sourceType`. This makes
  // import work offline (no network), avoids upstream content drift, and
  // means the original `sourceUri` is preserved on the restored document.
  if (input.restoreFromSnapshot) {
    if (!input.body || input.body.length === 0) {
      throw new KbValidationError(
        "restoreFromSnapshot=true requires a non-empty body",
      );
    }
    body = input.body;
    sourceUri = input.url ?? null;
  } else if (input.sourceType === "text" || input.sourceType === "file") {
    if (!input.body || input.body.length === 0) {
      throw new KbValidationError(
        `sourceType=${input.sourceType} requires a non-empty body`,
      );
    }
    body = input.body;
  } else if (input.sourceType === "url") {
    if (!input.url) throw new KbValidationError("sourceType=url requires a url");
    const fetched = await fetchUrlContent(ctx, input.url);
    body = fetched.body;
    mimeType = mimeType ?? fetched.mimeType;
    sourceUri = input.url;
  } else if (input.sourceType === "youtube") {
    if (!input.url) throw new KbValidationError("sourceType=youtube requires a url");
    const placeholder = youtubePlaceholderBody(input.url);
    body = placeholder.body;
    mimeType = mimeType ?? placeholder.mimeType;
    sourceUri = input.url;
    await logPrivacyEvent(ctx, {
      eventType: "knowledge.ingest_youtube",
      actor: ctx.userId ?? ctx.tenantId,
      target: input.url,
      severity: "info",
    });
  } else {
    throw new KbValidationError(`Unsupported sourceType: ${String(input.sourceType)}`);
  }

  const normalised = normaliseBody(body, mimeType);
  const sizeBytes = Buffer.byteLength(normalised, "utf8");
  if (sizeBytes > MAX_BODY_BYTES) {
    throw new KbValidationError(
      `Document body exceeds the ${MAX_BODY_BYTES}-byte ingest cap`,
    );
  }
  if (normalised.length === 0) {
    throw new KbValidationError("Document body is empty after normalisation");
  }
  const contentHash = sha256Hex(normalised);

  // Duplicate detection — same tenant, same hash.
  const existing = await db
    .select()
    .from(kbDocuments)
    .where(
      and(tenantScope(ctx, kbDocuments), eq(kbDocuments.contentHash, contentHash)),
    )
    .limit(1);
  if (existing[0] && !input.allowDuplicate) {
    return {
      document: toDocumentRow(existing[0]),
      duplicate: true,
      existingDocumentId: existing[0].id,
    };
  }

  const id = `kbd_${nanoid()}`;
  const chunks = chunkText(normalised);
  const tags = autoTags(normalised, input.tags);
  const summary = autoSummary(normalised);

  const now = Date.now();
  await db.transaction((tx) => {
    tx.insert(kbDocuments).values(
      withTenantValues(ctx, {
        id,
        collectionId: input.collectionId ?? null,
        title: input.title,
        sourceType: input.sourceType,
        sourceUri,
        mimeType: mimeType ?? null,
        body: normalised,
        contentHash,
        sizeBytes,
        chunkCount: chunks.length,
        tags: JSON.stringify(tags),
        summary,
        createdAt: now,
        updatedAt: now,
      }),
    ).run();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? "";
      tx.insert(kbChunks).values(
        withTenantValues(ctx, {
          id: `kbck_${nanoid()}`,
          documentId: id,
          position: i,
          text: chunk,
          tokens: approximateTokens(chunk),
          embedding: JSON.stringify(embed(chunk)),
        }),
      ).run();
    }
  });

  logger.info(
    { documentId: id, chunks: chunks.length, sizeBytes },
    "kb.ingest",
  );

  const inserted = await db
    .select()
    .from(kbDocuments)
    .where(and(tenantScope(ctx, kbDocuments), eq(kbDocuments.id, id)))
    .limit(1);
  if (!inserted[0]) throw new Error("Document vanished after insert");
  return {
    document: toDocumentRow(inserted[0]),
    duplicate: false,
    existingDocumentId: existing[0]?.id ?? null,
  };
}

export async function deleteDocument(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await db
    .select()
    .from(kbDocuments)
    .where(and(tenantScope(ctx, kbDocuments), eq(kbDocuments.id, id)))
    .limit(1);
  if (!existing[0]) return { id, deleted: false };
  await db.transaction((tx) => {
    tx
      .delete(kbChunks)
      .where(and(tenantScope(ctx, kbChunks), eq(kbChunks.documentId, id)))
      .run();
    tx
      .delete(kbDocuments)
      .where(and(tenantScope(ctx, kbDocuments), eq(kbDocuments.id, id)))
      .run();
  });
  return { id, deleted: true };
}

// ─── Search & RAG ───────────────────────────────────────────────────────────

function snippetForQuery(text: string, query: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  const lowered = text.toLowerCase();
  let idx = -1;
  for (const t of tokenise(query)) {
    const found = lowered.indexOf(t);
    if (found !== -1) {
      idx = found;
      break;
    }
  }
  if (idx === -1) return `${text.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
  const half = Math.floor(SNIPPET_MAX_CHARS / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, start + SNIPPET_MAX_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export async function search(
  ctx: TenantContext,
  opts: SearchOpts,
): Promise<KbSearchHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const queryTrim = opts.query.trim();
  if (queryTrim.length === 0) return [];
  const queryVec = embed(queryTrim);

  // Fetch chunk + parent document rows for the active tenant.
  const conditions = [tenantScope(ctx, kbChunks)];
  let documentFilter: Set<string> | null = null;
  if (opts.collectionId) {
    const docs = await db
      .select()
      .from(kbDocuments)
      .where(
        and(
          tenantScope(ctx, kbDocuments),
          eq(kbDocuments.collectionId, opts.collectionId),
        ),
      );
    documentFilter = new Set(docs.map((d) => d.id));
    if (documentFilter.size === 0) return [];
  }

  const chunkRows = await db
    .select()
    .from(kbChunks)
    .where(and(...conditions));

  if (chunkRows.length === 0) return [];

  const docIds = new Set<string>();
  for (const c of chunkRows) {
    if (documentFilter && !documentFilter.has(c.documentId)) continue;
    docIds.add(c.documentId);
  }
  const docRows = await db
    .select()
    .from(kbDocuments)
    .where(tenantScope(ctx, kbDocuments));
  const docById = new Map<string, typeof docRows[number]>();
  for (const d of docRows) docById.set(d.id, d);

  const scored: KbSearchHit[] = [];
  for (const c of chunkRows) {
    if (documentFilter && !documentFilter.has(c.documentId)) continue;
    const doc = docById.get(c.documentId);
    if (!doc) continue;
    let chunkVec: number[];
    try {
      const parsed = JSON.parse(c.embedding);
      chunkVec = Array.isArray(parsed) ? (parsed as number[]) : [];
    } catch {
      chunkVec = [];
    }
    const vectorScore = cosine(queryVec, chunkVec);
    const textScore = jaccardKeywordScore(queryTrim, c.text);
    const score = 0.6 * vectorScore + 0.4 * textScore;
    if (score <= 0) continue;
    scored.push({
      chunkId: c.id,
      documentId: doc.id,
      documentTitle: doc.title,
      position: c.position,
      snippet: snippetForQuery(c.text, queryTrim),
      score,
      vectorScore,
      textScore,
      sourceUri: doc.sourceUri,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * RAG helper used by the agent loop. Returns a compact, citation-friendly
 * markdown snippet block, plus the raw hits in case a caller wants to
 * surface them in the UI separately.
 */
export async function retrieveContext(
  ctx: TenantContext,
  query: string,
  opts: { limit?: number; collectionId?: string } = {},
): Promise<{ summary: string; hits: KbSearchHit[] }> {
  const hits = await search(ctx, {
    query,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.collectionId !== undefined ? { collectionId: opts.collectionId } : {}),
  });
  if (hits.length === 0) {
    return { summary: "Knowledge base returned no relevant snippets.", hits: [] };
  }
  const lines = hits.map(
    (h, i) =>
      `[${i + 1}] ${h.documentTitle} (chunk ${h.position + 1}, score ${h.score.toFixed(3)})\n    ${h.snippet}`,
  );
  return {
    summary: `Retrieved ${hits.length} knowledge-base snippet(s):\n${lines.join("\n")}`,
    hits,
  };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export async function stats(ctx: TenantContext): Promise<KbStats> {
  const [docs, colls, chunks] = await Promise.all([
    db.select().from(kbDocuments).where(tenantScope(ctx, kbDocuments)),
    db.select().from(kbCollections).where(tenantScope(ctx, kbCollections)),
    db.select().from(kbChunks).where(tenantScope(ctx, kbChunks)),
  ]);
  const totalSizeBytes = docs.reduce((acc, d) => acc + d.sizeBytes, 0);
  const lastUpdatedAt =
    docs.length === 0
      ? null
      : new Date(Math.max(...docs.map((d) => d.updatedAt))).toISOString();
  return {
    documentCount: docs.length,
    collectionCount: colls.length,
    chunkCount: chunks.length,
    totalSizeBytes,
    lastUpdatedAt,
  };
}

// ─── Export & import ────────────────────────────────────────────────────────

export async function exportSnapshot(ctx: TenantContext): Promise<KbExportSnapshot> {
  const colls = await db
    .select()
    .from(kbCollections)
    .where(tenantScope(ctx, kbCollections));
  const docs = await db
    .select()
    .from(kbDocuments)
    .where(tenantScope(ctx, kbDocuments));
  const docCounts = new Map<string, number>();
  for (const d of docs) {
    if (!d.collectionId) continue;
    docCounts.set(d.collectionId, (docCounts.get(d.collectionId) ?? 0) + 1);
  }
  return {
    exportedAt: new Date().toISOString(),
    version: "1",
    collections: colls.map((c) => toCollectionRow(c, docCounts.get(c.id) ?? 0)),
    documents: docs.map((d) => ({
      id: d.id,
      collectionId: d.collectionId,
      title: d.title,
      sourceType: d.sourceType,
      sourceUri: d.sourceUri,
      mimeType: d.mimeType,
      body: d.body,
      contentHash: d.contentHash,
      tags: parseTags(d.tags),
      summary: d.summary,
      createdAt: new Date(d.createdAt).toISOString(),
    })),
  };
}

export async function importSnapshot(
  ctx: TenantContext,
  snapshot: KbExportSnapshot,
  opts: { replaceExisting?: boolean } = {},
): Promise<KbImportResult> {
  // Optionally wipe existing data first — the export round-trip uses this
  // for restore-from-backup workflows.
  if (opts.replaceExisting) {
    await db.transaction((tx) => {
      tx.delete(kbChunks).where(tenantScope(ctx, kbChunks)).run();
      tx.delete(kbDocuments).where(tenantScope(ctx, kbDocuments)).run();
      tx.delete(kbCollections).where(tenantScope(ctx, kbCollections)).run();
    });
  }

  // Re-create collections, mapping the snapshot id → freshly-issued id.
  const collectionIdMap = new Map<string, string>();
  for (const c of snapshot.collections) {
    const newId = `kbc_${nanoid()}`;
    collectionIdMap.set(c.id, newId);
    await db.insert(kbCollections).values(
      withTenantValues(ctx, {
        id: newId,
        name: c.name,
        description: c.description ?? null,
        color: c.color ?? null,
      }),
    );
  }

  let documentsImported = 0;
  let documentsSkipped = 0;
  const errors: KbImportError[] = [];
  for (const d of snapshot.documents) {
    // Re-ingest via the canonical path so chunks + embeddings rebuild
    // deterministically — but with `restoreFromSnapshot: true` so the
    // body comes straight from the snapshot (no network re-fetch, immune
    // to upstream drift). Duplicate detection still runs against the
    // active tenant via the content-hash check.
    const tagsArr = Array.isArray(d.tags)
      ? d.tags.filter((t): t is string => typeof t === "string")
      : [];
    const collectionId = d.collectionId
      ? collectionIdMap.get(d.collectionId) ?? d.collectionId
      : undefined;
    try {
      const result = await ingestDocument(ctx, {
        sourceType: (d.sourceType as KbSourceType) ?? "text",
        title: d.title,
        body: d.body,
        restoreFromSnapshot: true,
        ...(d.mimeType ? { mimeType: d.mimeType } : {}),
        ...(d.sourceUri ? { url: d.sourceUri } : {}),
        ...(collectionId ? { collectionId } : {}),
        tags: tagsArr,
        allowDuplicate: false,
      });
      if (result.duplicate) documentsSkipped++;
      else documentsImported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({
        title: d.title,
        sourceDocumentId: d.id,
        message,
      });
      documentsSkipped++;
      logger.warn(
        { documentId: d.id, title: d.title, err: message },
        "kb.importSnapshot: document failed to import",
      );
    }
  }

  return {
    collectionsImported: snapshot.collections.length,
    documentsImported,
    documentsSkipped,
    errors,
  };
}
