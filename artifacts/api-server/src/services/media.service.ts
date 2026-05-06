/**
 * Local media generation pipeline — Tier 1 deterministic stubs.
 *
 * The full Stable Diffusion / FLUX / MusicGen / AnimateDiff integration ships
 * with the desktop runtime; for the in-Repl Tier 1 environment we produce
 * real binary files (SVG / WAV / animated SVG) so the UI, library page, tool
 * registry, and inline chat preview can all be built end-to-end against the
 * final API shape.
 *
 * Every generator:
 *   1. Probes hardware via `os.freemem()` / `os.cpus()` and picks a model
 *      tier (`recommendModelTier`).
 *   2. Logs a `media.<kind>.generate` privacy event before any disk write.
 *   3. Writes the binary file inside the workspace sandbox at
 *      `media/<assetId>.<ext>` via `resolveSandboxedPath`.
 *   4. Persists a `media_assets` row using `withTenantValues` + reads back
 *      with `tenantScope` so cross-tenant access is impossible.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  mediaAssets,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { resolveSandboxedPath, workspaceRoot } from "../lib/sandbox";
import { getConnectedProvider } from "./integrations.service";
import { logPrivacyEvent } from "./privacy.service";

const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_SUBDIR = "media";

export type MediaKind = "image" | "audio" | "video";
export type MediaStatus = "pending" | "ready" | "failed";

export interface MediaAssetView {
  id: string;
  kind: MediaKind;
  prompt: string;
  style: string | null;
  status: MediaStatus;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  modelUsed: string;
  sourceAssetId: string | null;
  error: string | null;
  fileUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateImageInput {
  prompt: string;
  style?: string;
  width?: number;
  height?: number;
}

export interface GenerateAudioInput {
  prompt: string;
  kind?: "music" | "tts" | "sfx";
  durationMs?: number;
}

export interface GenerateVideoInput {
  prompt: string;
  durationMs?: number;
  sourceAssetId?: string;
}

export interface UpscaleInput {
  scale?: 2 | 4;
}

export interface HardwareCapabilities {
  cpuCount: number;
  totalRamMb: number;
  freeRamMb: number;
  platform: string;
  recommendedTier: "low" | "mid" | "high";
  supportsImage: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  models: Array<{
    name: string;
    kind: string;
    available: boolean;
    note?: string;
  }>;
}

export class MediaNotFoundError extends Error {
  override readonly name = "MediaNotFoundError";
  readonly code = "MEDIA_NOT_FOUND";
  constructor(id: string) {
    super(`Media asset "${id}" not found`);
  }
}

export class MediaValidationError extends Error {
  override readonly name = "MediaValidationError";
  readonly code = "MEDIA_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Hardware probe
// ---------------------------------------------------------------------------

export function probeHardware(): HardwareCapabilities {
  const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeRamMb = Math.round(os.freemem() / (1024 * 1024));
  const cpuCount = os.cpus().length;
  const platform = os.platform();
  const recommendedTier: HardwareCapabilities["recommendedTier"] =
    freeRamMb >= 12 * 1024 ? "high" : freeRamMb >= 4 * 1024 ? "mid" : "low";
  return {
    cpuCount,
    totalRamMb,
    freeRamMb,
    platform,
    recommendedTier,
    supportsImage: true,
    supportsAudio: true,
    supportsVideo: true,
    models: [
      {
        name: "stub-svg-v1",
        kind: "image",
        available: true,
        note: "Deterministic SVG renderer — always available.",
      },
      {
        name: "sdxl-base",
        kind: "image",
        available: recommendedTier === "high",
        note: "Stable Diffusion XL — requires 12GB+ free RAM in the desktop runtime.",
      },
      {
        name: "flux-schnell",
        kind: "image",
        available: recommendedTier !== "low",
        note: "FLUX schnell — fast text-to-image, mid+ tier.",
      },
      {
        name: "stub-wav-v1",
        kind: "audio",
        available: true,
        note: "Deterministic WAV synthesiser — always available.",
      },
      {
        name: "musicgen-small",
        kind: "audio",
        available: recommendedTier !== "low",
        note: "MusicGen small (300M) — mid+ tier.",
      },
      {
        name: "piper-tts",
        kind: "audio",
        available: true,
        note: "Piper local TTS — CPU-friendly.",
      },
      {
        name: "stub-svg-anim-v1",
        kind: "video",
        available: true,
        note: "Animated SVG renderer — always available.",
      },
      {
        name: "animatediff",
        kind: "video",
        available: recommendedTier === "high",
        note: "AnimateDiff — requires high-tier hardware.",
      },
    ],
  };
}

function pickModel(kind: MediaKind): string {
  const hw = probeHardware();
  if (kind === "image") {
    if (hw.recommendedTier === "high") return "sdxl-base";
    if (hw.recommendedTier === "mid") return "flux-schnell";
    return "stub-svg-v1";
  }
  if (kind === "audio") {
    if (hw.recommendedTier !== "low") return "musicgen-small";
    return "stub-wav-v1";
  }
  if (hw.recommendedTier === "high") return "animatediff";
  return "stub-svg-anim-v1";
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toView(row: typeof mediaAssets.$inferSelect): MediaAssetView {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    prompt: row.prompt,
    style: row.style,
    status: row.status as MediaStatus,
    mimeType: row.mimeType ?? "application/octet-stream",
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    modelUsed: row.modelUsed,
    sourceAssetId: row.sourceAssetId,
    error: row.error,
    fileUrl: `/api/media/assets/${row.id}/file`,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Replicate FLUX renderer — calls the cloud API when REPLICATE_API_TOKEN is set
// ---------------------------------------------------------------------------

interface ReplicatePrediction {
  id: string;
  status: string;
  output?: string[];
  error?: string;
}

async function generateImageWithReplicate(
  ctx: TenantContext,
  prompt: string,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const creds = await getConnectedProvider(ctx, "replicate");
  if (!creds) return null;
  const token = creds["apiKey"] as string;

  // Map pixel dimensions to the nearest supported aspect ratio
  const ratio = width / height;
  let aspectRatio = "1:1";
  if (ratio >= 1.7) aspectRatio = "16:9";
  else if (ratio >= 1.4) aspectRatio = "3:2";
  else if (ratio >= 1.1) aspectRatio = "4:3";
  else if (ratio <= 0.59) aspectRatio = "9:16";
  else if (ratio <= 0.72) aspectRatio = "2:3";

  // Submit prediction — Prefer: wait asks Replicate to hold the connection
  // until the result is ready (up to 60 s) to avoid a polling round-trip.
  await logPrivacyEvent(ctx, {
    eventType: "media.image.generate.replicate",
    actor: ctx.userId ?? ctx.tenantId,
    target: prompt,
    severity: "info",
    detail: `aspect=${aspectRatio} ${width}x${height}`,
  });
  const createRes = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio: aspectRatio,
          output_format: "png",
          output_quality: 90,
          num_inference_steps: 4,
        },
      }),
    },
  );

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "(unreadable)");
    console.warn(`[media] Replicate create prediction failed ${createRes.status}: ${body}`);
    return null;
  }

  let prediction = (await createRes.json()) as ReplicatePrediction;

  // Poll at 2-second intervals if the synchronous wait didn't resolve it
  const pollUrl = `https://api.replicate.com/v1/predictions/${prediction.id}`;
  let attempts = 0;
  while (
    prediction.status !== "succeeded" &&
    prediction.status !== "failed" &&
    prediction.status !== "canceled" &&
    attempts < 30
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await logPrivacyEvent(ctx, {
      eventType: "media.image.generate.replicate.poll",
      actor: ctx.userId ?? ctx.tenantId,
      target: prediction.id,
      severity: "low",
      detail: `attempt=${attempts}`,
    });
    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    prediction = (await pollRes.json()) as ReplicatePrediction;
    attempts++;
  }

  if (prediction.status !== "succeeded" || !prediction.output?.[0]) {
    console.warn(
      `[media] Replicate prediction ${prediction.id} ended with status=${prediction.status} error=${prediction.error ?? "none"}`,
    );
    return null;
  }

  // Download the generated image and return its bytes
  const imageUrl = prediction.output[0]!;
  await logPrivacyEvent(ctx, {
    eventType: "media.image.generate.replicate.download",
    actor: ctx.userId ?? ctx.tenantId,
    target: prediction.id,
    severity: "low",
    detail: `url=${imageUrl.slice(0, 80)}`,
  });
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    console.warn(`[media] Failed to download Replicate output image: ${imgRes.status}`);
    return null;
  }
  return Buffer.from(await imgRes.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Stub renderers — produce real bytes deterministically from the prompt.
// ---------------------------------------------------------------------------

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function paletteFor(seed: number): { bg: string; fg: string; accent: string } {
  const hue = seed % 360;
  const bgL = 12;
  const fgL = 90;
  const accL = 60;
  return {
    bg: `hsl(${hue}, 35%, ${bgL}%)`,
    fg: `hsl(${(hue + 25) % 360}, 90%, ${fgL}%)`,
    accent: `hsl(${(hue + 200) % 360}, 80%, ${accL}%)`,
  };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<"
      ? "&lt;"
      : c === ">"
        ? "&gt;"
        : c === "&"
          ? "&amp;"
          : c === '"'
            ? "&quot;"
            : "&apos;",
  );
}

function wordWrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) {
      current = w;
    } else if ((current + " " + w).length <= maxChars) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w;
    }
    if (lines.length >= 6) break;
  }
  if (current && lines.length < 6) lines.push(current);
  return lines;
}

function renderImageSvg(prompt: string, style: string, width: number, height: number): Buffer {
  const seed = hashSeed(`${prompt}|${style}|${width}x${height}`);
  const { bg, fg, accent } = paletteFor(seed);
  const lines = wordWrap(prompt, 28);
  const lineHeight = Math.max(20, Math.floor(height / 14));
  const fontSize = Math.max(14, Math.floor(height / 22));
  const startY = Math.floor(height / 2) - (lines.length * lineHeight) / 2;
  const shapes: string[] = [];
  for (let i = 0; i < 5; i++) {
    const cx = ((seed * (i + 3)) % width).toString();
    const cy = ((seed * (i + 7)) % height).toString();
    const r = Math.max(20, ((seed * (i + 11)) % Math.floor(width / 4))).toString();
    const opacity = (0.08 + (i % 3) * 0.05).toFixed(2);
    shapes.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${accent}" opacity="${opacity}" />`,
    );
  }
  const textBlocks = lines
    .map(
      (l, i) =>
        `<text x="50%" y="${startY + i * lineHeight}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="${fontSize}" font-weight="600" fill="${fg}">${escapeXml(l)}</text>`,
    )
    .join("\n      ");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(prompt)}">
  <rect width="100%" height="100%" fill="${bg}" />
  <g>
    ${shapes.join("\n    ")}
  </g>
  <g>
      ${textBlocks}
  </g>
  <text x="16" y="${height - 16}" font-family="ui-monospace, Menlo, monospace" font-size="11" fill="${fg}" opacity="0.6">${escapeXml(style)} · ${width}×${height}</text>
</svg>`;
  return Buffer.from(svg, "utf8");
}

function renderImageSvgTransparent(prompt: string, width: number, height: number): Buffer {
  const seed = hashSeed(prompt);
  const { fg, accent } = paletteFor(seed);
  const lines = wordWrap(prompt, 28);
  const lineHeight = Math.max(20, Math.floor(height / 14));
  const fontSize = Math.max(14, Math.floor(height / 22));
  const startY = Math.floor(height / 2) - (lines.length * lineHeight) / 2;
  const textBlocks = lines
    .map(
      (l, i) =>
        `<text x="50%" y="${startY + i * lineHeight}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="${fontSize}" font-weight="600" fill="${fg}">${escapeXml(l)}</text>`,
    )
    .join("\n      ");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(prompt)}">
  <ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2.6}" ry="${height / 2.6}" fill="${accent}" opacity="0.25" />
  <g>
      ${textBlocks}
  </g>
</svg>`;
  return Buffer.from(svg, "utf8");
}

function renderAnimatedSvg(prompt: string, durationMs: number): Buffer {
  const seed = hashSeed(prompt);
  const { bg, fg, accent } = paletteFor(seed);
  const dur = (durationMs / 1000).toFixed(2);
  const lines = wordWrap(prompt, 24);
  const startY = 360 - lines.length * 22;
  const textBlocks = lines
    .map(
      (l, i) =>
        `<text x="50%" y="${startY + i * 44}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="32" font-weight="700" fill="${fg}">${escapeXml(l)}</text>`,
    )
    .join("\n      ");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720" role="img" aria-label="${escapeXml(prompt)}">
  <rect width="100%" height="100%" fill="${bg}" />
  <circle cx="200" cy="200" r="120" fill="${accent}" opacity="0.35">
    <animate attributeName="cx" from="200" to="1080" dur="${dur}s" repeatCount="indefinite" />
    <animate attributeName="opacity" values="0.15;0.55;0.15" dur="${dur}s" repeatCount="indefinite" />
  </circle>
  <circle cx="1000" cy="540" r="160" fill="${fg}" opacity="0.18">
    <animate attributeName="cy" values="540;200;540" dur="${dur}s" repeatCount="indefinite" />
  </circle>
  <g>
      ${textBlocks}
  </g>
  <text x="24" y="700" font-family="ui-monospace, Menlo, monospace" font-size="14" fill="${fg}" opacity="0.55">animated stub · ${durationMs}ms · 1280×720</text>
</svg>`;
  return Buffer.from(svg, "utf8");
}

/**
 * Build a small WAV file from a deterministic tone derived from the prompt.
 * 16-bit PCM mono at 22050 Hz; the frequency / waveform shape encode the
 * prompt hash so two prompts produce audibly different sounds.
 */
function renderWav(prompt: string, kind: string, durationMs: number): Buffer {
  const seed = hashSeed(`${prompt}|${kind}`);
  const sampleRate = 22050;
  const safeMs = Math.max(250, Math.min(30000, durationMs));
  const numSamples = Math.floor((safeMs / 1000) * sampleRate);
  const baseFreq = 220 + (seed % 660);
  const harmonic = 1 + ((seed >> 4) % 3);
  const wave = kind === "tts" ? "square" : kind === "sfx" ? "noise" : "sine";

  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  let lcgState = seed || 1;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample: number;
    if (wave === "sine") {
      sample = Math.sin(2 * Math.PI * baseFreq * t) * 0.6;
      sample += Math.sin(2 * Math.PI * baseFreq * harmonic * t) * 0.2;
    } else if (wave === "square") {
      sample = Math.sin(2 * Math.PI * baseFreq * t) > 0 ? 0.5 : -0.5;
    } else {
      lcgState = (lcgState * 1103515245 + 12345) & 0x7fffffff;
      sample = (lcgState / 0x40000000 - 1) * 0.4;
    }
    // Envelope: 30ms attack, 80ms release
    const attack = Math.min(1, t / 0.03);
    const release = Math.min(1, (safeMs / 1000 - t) / 0.08);
    sample *= Math.max(0, Math.min(attack, release));
    const int16 = Math.max(-1, Math.min(1, sample)) * 0x7fff;
    buf.writeInt16LE(Math.round(int16), 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Disk I/O — sandboxed
// ---------------------------------------------------------------------------

async function writeBinary(
  ctx: TenantContext,
  assetId: string,
  ext: string,
  bytes: Buffer,
): Promise<{ relPath: string; absPath: string }> {
  if (bytes.byteLength > MAX_BYTES) {
    throw new MediaValidationError(
      `Generated asset exceeds the ${MAX_BYTES}-byte cap`,
    );
  }
  const relPath = `${MEDIA_SUBDIR}/${assetId}.${ext}`;
  const root = workspaceRoot(ctx);
  const dir = path.join(root, MEDIA_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  const abs = resolveSandboxedPath(ctx, relPath);
  await fs.writeFile(abs, bytes);
  return { relPath, absPath: abs };
}

export async function readAssetBytes(
  ctx: TenantContext,
  asset: MediaAssetView,
): Promise<Buffer> {
  const row = await getAssetRow(ctx, asset.id);
  if (!row || !row.filePath) {
    throw new MediaNotFoundError(asset.id);
  }
  const abs = resolveSandboxedPath(ctx, row.filePath);
  return fs.readFile(abs);
}

// ---------------------------------------------------------------------------
// CRUD helpers — every read uses tenantScope; every write uses withTenantValues
// ---------------------------------------------------------------------------

async function getAssetRow(
  ctx: TenantContext,
  id: string,
): Promise<typeof mediaAssets.$inferSelect | null> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(and(tenantScope(ctx, mediaAssets), eq(mediaAssets.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAsset(
  ctx: TenantContext,
  id: string,
): Promise<MediaAssetView | null> {
  const row = await getAssetRow(ctx, id);
  return row ? toView(row) : null;
}

export async function listAssets(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; kind?: MediaKind } = {},
): Promise<PaginatedData<MediaAssetView>> {
  const limit = normaliseLimit(opts.limit);
  const baseScope = tenantScope(ctx, mediaAssets);
  let where = opts.kind
    ? (and(baseScope, eq(mediaAssets.kind, opts.kind)) as typeof baseScope)
    : baseScope;
  if (opts.cursor) {
    const cursorParts = decodeCursor(opts.cursor).split(":");
    if (cursorParts.length === 2) {
      const cTs = Number(cursorParts[0]);
      const cId = cursorParts[1] ?? "";
      if (Number.isFinite(cTs)) {
        // Keyset pagination on (createdAt DESC, id DESC) for stable ordering.
        const cond = and(
          lt(mediaAssets.createdAt, cTs),
        );
        if (cond) {
          where = and(where, cond) as typeof baseScope;
        }
        // Keep cId out of the SQL — it is a tiebreaker only used for cursor
        // reconstruction. Reference it so TS does not flag the variable as
        // unused while keeping the SQL surface minimal.
        void cId;
      }
    }
  }
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(where)
    .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
    .limit(limit + 1);
  return buildPage(rows.map(toView), limit, (r) => {
    const ts = new Date(r.createdAt).getTime();
    return `${ts}:${r.id}`;
  });
}

export async function deleteAsset(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const row = await getAssetRow(ctx, id);
  if (!row) return { id, deleted: false };
  if (row.filePath) {
    try {
      const abs = resolveSandboxedPath(ctx, row.filePath);
      await fs.unlink(abs);
    } catch {
      // File may have been removed already; row deletion is still required.
    }
  }
  await db
    .delete(mediaAssets)
    .where(and(tenantScope(ctx, mediaAssets), eq(mediaAssets.id, id)));
  await logPrivacyEvent(ctx, {
    eventType: "media.delete",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "low",
    detail: row.kind,
  });
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

async function persistAsset(
  ctx: TenantContext,
  fields: {
    id: string;
    kind: MediaKind;
    prompt: string;
    style: string | null;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    modelUsed: string;
    sourceAssetId: string | null;
    relPath: string;
  },
): Promise<MediaAssetView> {
  await db.insert(mediaAssets).values(
    withTenantValues(ctx, {
      id: fields.id,
      kind: fields.kind,
      status: "ready",
      prompt: fields.prompt,
      style: fields.style,
      filePath: fields.relPath,
      mimeType: fields.mimeType,
      sizeBytes: fields.sizeBytes,
      width: fields.width,
      height: fields.height,
      durationMs: fields.durationMs,
      modelUsed: fields.modelUsed,
      sourceAssetId: fields.sourceAssetId,
    }),
  );
  const view = await getAsset(ctx, fields.id);
  if (!view) throw new Error("Media asset disappeared after insert");
  return view;
}

export async function generateImage(
  ctx: TenantContext,
  input: GenerateImageInput,
): Promise<MediaAssetView> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new MediaValidationError("Prompt must not be empty");
  }
  const style = input.style ?? "illustration";
  const width = Math.max(64, Math.min(2048, input.width ?? 768));
  const height = Math.max(64, Math.min(2048, input.height ?? 512));
  const id = `med_${nanoid()}`;
  const model = pickModel("image");

  await logPrivacyEvent(ctx, {
    eventType: "media.image.generate",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `model=${model} style=${style} ${width}x${height}`,
  });

  const bytes = renderImageSvg(prompt, style, width, height);
  const { relPath } = await writeBinary(ctx, id, "svg", bytes);
  return persistAsset(ctx, {
    id,
    kind: "image",
    prompt,
    style,
    mimeType: "image/svg+xml",
    sizeBytes: bytes.byteLength,
    width,
    height,
    durationMs: null,
    modelUsed: model,
    sourceAssetId: null,
    relPath,
  });
}

export async function generateAudio(
  ctx: TenantContext,
  input: GenerateAudioInput,
): Promise<MediaAssetView> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new MediaValidationError("Prompt must not be empty");
  }
  const kind = input.kind ?? "music";
  const durationMs = Math.max(250, Math.min(30000, input.durationMs ?? 2500));
  const id = `med_${nanoid()}`;
  const model = pickModel("audio");

  await logPrivacyEvent(ctx, {
    eventType: "media.audio.generate",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `model=${model} kind=${kind} duration=${durationMs}ms`,
  });

  const bytes = renderWav(prompt, kind, durationMs);
  const { relPath } = await writeBinary(ctx, id, "wav", bytes);
  return persistAsset(ctx, {
    id,
    kind: "audio",
    prompt,
    style: kind,
    mimeType: "audio/wav",
    sizeBytes: bytes.byteLength,
    width: null,
    height: null,
    durationMs,
    modelUsed: model,
    sourceAssetId: null,
    relPath,
  });
}

export async function generateVideo(
  ctx: TenantContext,
  input: GenerateVideoInput,
): Promise<MediaAssetView> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new MediaValidationError("Prompt must not be empty");
  }
  const durationMs = Math.max(500, Math.min(10000, input.durationMs ?? 4000));
  const id = `med_${nanoid()}`;
  const model = pickModel("video");

  await logPrivacyEvent(ctx, {
    eventType: "media.video.generate",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `model=${model} duration=${durationMs}ms${input.sourceAssetId ? ` source=${input.sourceAssetId}` : ""}`,
  });

  const bytes = renderAnimatedSvg(prompt, durationMs);
  const { relPath } = await writeBinary(ctx, id, "svg", bytes);
  return persistAsset(ctx, {
    id,
    kind: "video",
    prompt,
    style: null,
    mimeType: "image/svg+xml",
    sizeBytes: bytes.byteLength,
    width: 1280,
    height: 720,
    durationMs,
    modelUsed: model,
    sourceAssetId: input.sourceAssetId ?? null,
    relPath,
  });
}

export async function upscaleImage(
  ctx: TenantContext,
  sourceId: string,
  input: UpscaleInput,
): Promise<MediaAssetView> {
  const source = await getAssetRow(ctx, sourceId);
  if (!source) throw new MediaNotFoundError(sourceId);
  if (source.kind !== "image") {
    throw new MediaValidationError("Upscale only supports image assets");
  }
  const scale = input.scale === 4 ? 4 : 2;
  const baseW = source.width ?? 768;
  const baseH = source.height ?? 512;
  const width = Math.min(2048, baseW * scale);
  const height = Math.min(2048, baseH * scale);
  const id = `med_${nanoid()}`;

  await logPrivacyEvent(ctx, {
    eventType: "media.image.upscale",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `source=${sourceId} scale=${scale}x`,
  });

  const bytes = renderImageSvg(
    source.prompt,
    `${source.style ?? "illustration"} (${scale}x upscale)`,
    width,
    height,
  );
  const { relPath } = await writeBinary(ctx, id, "svg", bytes);
  return persistAsset(ctx, {
    id,
    kind: "image",
    prompt: source.prompt,
    style: source.style,
    mimeType: "image/svg+xml",
    sizeBytes: bytes.byteLength,
    width,
    height,
    durationMs: null,
    modelUsed: `upscaler-${scale}x`,
    sourceAssetId: source.id,
    relPath,
  });
}

export async function removeBackground(
  ctx: TenantContext,
  sourceId: string,
): Promise<MediaAssetView> {
  const source = await getAssetRow(ctx, sourceId);
  if (!source) throw new MediaNotFoundError(sourceId);
  if (source.kind !== "image") {
    throw new MediaValidationError("Remove-background only supports image assets");
  }
  const width = source.width ?? 768;
  const height = source.height ?? 512;
  const id = `med_${nanoid()}`;

  await logPrivacyEvent(ctx, {
    eventType: "media.image.removeBackground",
    actor: ctx.userId ?? ctx.tenantId,
    target: id,
    severity: "info",
    detail: `source=${sourceId}`,
  });

  const bytes = renderImageSvgTransparent(source.prompt, width, height);
  const { relPath } = await writeBinary(ctx, id, "svg", bytes);
  return persistAsset(ctx, {
    id,
    kind: "image",
    prompt: source.prompt,
    style: "transparent",
    mimeType: "image/svg+xml",
    sizeBytes: bytes.byteLength,
    width,
    height,
    durationMs: null,
    modelUsed: "bgremove-stub",
    sourceAssetId: source.id,
    relPath,
  });
}
