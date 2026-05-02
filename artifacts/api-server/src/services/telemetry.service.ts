/**
 * Telemetry service — opt-in analytics, performance metrics, onboarding
 * funnel events, and crash reports.
 *
 * The privacy enforcement layer in this file is the single gate that:
 *   1. Refuses to record any event/crash when the per-category opt-in flag
 *      is OFF (default-OFF guarantee — Section 12.10 of the project
 *      context).
 *   2. Strips PII, file paths, URLs with credentials, email addresses, and
 *      anything resembling a token from event payloads and crash stacks
 *      before they reach the database.
 *   3. Refuses entirely-forbidden keys (`password`, `secret`, `token`,
 *      `apiKey`, `email`, `path`, `filePath`, `prompt`, `response`,
 *      `content`).
 *
 * Singleton-per-tenant settings: at most one row in `telemetry_settings`
 * keyed on `tenantId` (which IS the row id). A missing row means "all
 * opt-ins off, no consent timestamps" — the same shape the GET endpoint
 * returns from the empty branch, so callers never have to special-case it.
 *
 * Append-only events + crash reports: writes never UPDATE; the `version`
 * column on `crash_reports` exists solely to satisfy the tier-review
 * schema gate (the table name does not match the version-exempt keyword
 * list, even though writes are append-only).
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  crashReports,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  telemetryEvents,
  telemetrySettings,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export type TelemetryCategory =
  | "feature_usage"
  | "performance"
  | "onboarding"
  | "marketplace";

export const TELEMETRY_CATEGORIES: readonly TelemetryCategory[] = [
  "feature_usage",
  "performance",
  "onboarding",
  "marketplace",
];

export interface TelemetryConsent {
  optInUsage: boolean;
  optInPerformance: boolean;
  optInCrashes: boolean;
  optInOnboarding: boolean;
  optInMarketplace: boolean;
  anonymousId: string;
  consentGivenAt: string | null;
  consentRevokedAt: string | null;
  updatedAt: string;
}

export interface TelemetryConsentInput {
  optInUsage?: boolean;
  optInPerformance?: boolean;
  optInCrashes?: boolean;
  optInOnboarding?: boolean;
  optInMarketplace?: boolean;
}

export interface TelemetryEventInput {
  category: TelemetryCategory;
  eventName: string;
  payload?: Record<string, unknown>;
  opVersion?: string;
  osPlatform?: string;
  hardwareTier?: string;
  durationMs?: number;
}

export interface TelemetryEventRecord {
  id: string;
  category: string;
  eventName: string;
  payload: Record<string, unknown>;
  opVersion: string;
  osPlatform: string | null;
  hardwareTier: string | null;
  durationMs: number | null;
  anonymousId: string;
  createdAt: string;
}

export interface CrashReportInput {
  message: string;
  stackTrace?: string;
  breadcrumbs?: string;
  fingerprint?: string;
  opVersion?: string;
  osPlatform?: string;
  osVersion?: string;
  hardwareTier?: string;
}

export interface CrashReportRecord {
  id: string;
  fingerprint: string;
  message: string;
  stackTrace: string | null;
  breadcrumbs: string | null;
  opVersion: string;
  osPlatform: string | null;
  osVersion: string | null;
  hardwareTier: string | null;
  anonymousId: string;
  submittedAt: string | null;
  githubIssueUrl: string | null;
  createdAt: string;
}

export interface TelemetryRecordResult {
  accepted: number;
  rejected: number;
  rejections: Array<{ index: number; reason: string }>;
  records: TelemetryEventRecord[];
}

export interface TelemetrySummary {
  totalEvents: number;
  totalCrashes: number;
  uniqueAnonymousIds: number;
  categoryCounts: Array<{ category: string; count: number }>;
  topEventNames: Array<{ eventName: string; count: number }>;
  hardwareTierCounts: Array<{ tier: string; count: number }>;
  onboardingFunnel: Array<{ step: string; count: number }>;
  topCrashFingerprints: Array<{ fingerprint: string; count: number; lastSeenAt: string }>;
  generatedAt: string;
}

export class TelemetryConsentDeniedError extends Error {
  override readonly name = "TelemetryConsentDeniedError";
  constructor(public readonly category: string) {
    super(`Telemetry consent denied for category "${category}"`);
  }
}

export class TelemetryPiiError extends Error {
  override readonly name = "TelemetryPiiError";
  constructor(public readonly field: string, public readonly reason: string) {
    super(`Telemetry payload rejected — ${field}: ${reason}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Privacy enforcement layer
// ─────────────────────────────────────────────────────────────────────────

/**
 * Keys that may NEVER appear in a telemetry payload regardless of value —
 * the names alone are a signal of intent to leak. The check is
 * case-insensitive and matches whole keys (no substring match), so a key
 * named `eventName` is fine even though it contains "name".
 */
// tier-review: bounded — fixed allowlist of key names; never grows at runtime.
const FORBIDDEN_KEY_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "cookie",
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "ssn",
  "address",
  "fullname",
  "username",
  "path",
  "filepath",
  "filename",
  "file",
  "filecontent",
  "content",
  "prompt",
  "response",
  "message",
  "messages",
  "transcript",
  "screenshot",
  "image",
  "audio",
  "video",
  "userid",
  "user_id",
]);

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// Absolute paths on POSIX (`/foo`), Windows (`C:\foo`), and home-relative (`~/foo`).
const PATH_RE = /(?:^|[\s])(?:\/[A-Za-z0-9._-][^\s]*|[A-Za-z]:\\[^\s]+|~\/[^\s]+)/;
// URL credentials: `https://user:pass@host`.
const URL_CRED_RE = /https?:\/\/[^/\s:]+:[^/\s@]+@/;
// Long base64/hex blob — likely a token or signature.
const TOKEN_LIKE_RE = /\b[A-Za-z0-9_-]{32,}\b/;

const MAX_PAYLOAD_KEYS = 32;
const MAX_PAYLOAD_DEPTH = 4;
const MAX_STRING_LEN = 500;

/**
 * Recursively scrub a payload object. Returns a new object with the same
 * shape minus any forbidden keys / PII-bearing values. Throws
 * `TelemetryPiiError` when a forbidden key is present so the client knows
 * the event was rejected (versus silently dropped).
 *
 * Allowed value types: string, number, boolean, null, plain objects, and
 * arrays of these. Functions, Dates, Maps, Sets, and other exotica are
 * coerced to `null`.
 */
export function sanitizeTelemetryPayload(
  raw: unknown,
  field = "payload",
): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TelemetryPiiError(field, "payload must be a JSON object");
  }
  return scrubObject(raw as Record<string, unknown>, field, 0);
}

function scrubObject(
  input: Record<string, unknown>,
  field: string,
  depth: number,
): Record<string, unknown> {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new TelemetryPiiError(field, `nested deeper than ${MAX_PAYLOAD_DEPTH} levels`);
  }
  const keys = Object.keys(input);
  if (keys.length > MAX_PAYLOAD_KEYS) {
    throw new TelemetryPiiError(field, `more than ${MAX_PAYLOAD_KEYS} keys`);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const lc = key.toLowerCase().replace(/[_-]/g, "");
    if (FORBIDDEN_KEY_NAMES.has(lc)) {
      throw new TelemetryPiiError(`${field}.${key}`, "forbidden key");
    }
    out[key] = scrubValue(input[key], `${field}.${key}`, depth + 1);
  }
  return out;
}

function scrubValue(value: unknown, field: string, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubString(value, field);
  if (Array.isArray(value)) {
    return value.map((v, i) => scrubValue(v, `${field}[${i}]`, depth + 1));
  }
  if (typeof value === "object") {
    return scrubObject(value as Record<string, unknown>, field, depth);
  }
  // Functions, symbols, etc. — drop.
  return null;
}

function scrubString(value: string, field: string): string {
  if (value.length > MAX_STRING_LEN) {
    throw new TelemetryPiiError(field, `string longer than ${MAX_STRING_LEN} chars`);
  }
  // URL-with-credentials is checked BEFORE email because the credential
  // suffix `user:pass@host.tld` always also matches the email regex —
  // we want the more-specific reason in the rejection record.
  if (URL_CRED_RE.test(value)) throw new TelemetryPiiError(field, "URL contains credentials");
  if (EMAIL_RE.test(value)) throw new TelemetryPiiError(field, "looks like an email");
  if (PATH_RE.test(value)) throw new TelemetryPiiError(field, "looks like a file path");
  if (TOKEN_LIKE_RE.test(value)) throw new TelemetryPiiError(field, "looks like a token");
  return value;
}

/**
 * Mask a stack trace / breadcrumb blob so it can be safely stored. We
 * neutralise the same patterns the payload scrubber rejects, but for free
 * text we mask in-place rather than throw — a stack trace that mentions a
 * file path is normal and useful, but the path itself must be redacted.
 */
export function sanitizeStackTrace(input: string | undefined | null): string | null {
  if (!input) return null;
  let out = input.length > 8000 ? input.slice(0, 8000) : input;
  out = out.replace(EMAIL_RE, "[redacted-email]");
  // Replace path-like substrings (without the leading whitespace).
  out = out.replace(/(?:\/[A-Za-z0-9._-][^\s)]*|[A-Za-z]:\\[^\s)]+|~\/[^\s)]+)/g, "[redacted-path]");
  out = out.replace(URL_CRED_RE, "[redacted-url]");
  // Mask long token-like blobs but keep readable identifiers (≥ 32 chars).
  out = out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Consent (singleton per tenant)
// ─────────────────────────────────────────────────────────────────────────

function defaultConsent(anonymousId: string, updatedAtMs: number): TelemetryConsent {
  return {
    optInUsage: false,
    optInPerformance: false,
    optInCrashes: false,
    optInOnboarding: false,
    optInMarketplace: false,
    anonymousId,
    consentGivenAt: null,
    consentRevokedAt: null,
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

function rowToConsent(row: typeof telemetrySettings.$inferSelect): TelemetryConsent {
  return {
    optInUsage: row.optInUsage === 1,
    optInPerformance: row.optInPerformance === 1,
    optInCrashes: row.optInCrashes === 1,
    optInOnboarding: row.optInOnboarding === 1,
    optInMarketplace: row.optInMarketplace === 1,
    anonymousId: row.anonymousId,
    consentGivenAt:
      row.consentGivenAt !== null ? new Date(row.consentGivenAt).toISOString() : null,
    consentRevokedAt:
      row.consentRevokedAt !== null ? new Date(row.consentRevokedAt).toISOString() : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function getTelemetryConsent(ctx: TenantContext): Promise<TelemetryConsent> {
  const rows = await db
    .select()
    .from(telemetrySettings)
    .where(tenantScope(ctx, telemetrySettings))
    .limit(1);
  const row = rows[0];
  if (row) return rowToConsent(row);
  // No row yet — return the default-OFF shape without inserting. The route
  // doesn't care; the next PUT will create the row.
  return defaultConsent(`anon_${nanoid(16)}`, Date.now());
}

/**
 * Upsert the singleton consent row. Any field omitted from the input is
 * left at its current value (or default-OFF on first-write). When
 * `revokeAll` is true, every flag is forced to false and
 * `consentRevokedAt` is stamped — used by the "delete my telemetry" UX.
 */
export async function updateTelemetryConsent(
  ctx: TenantContext,
  input: TelemetryConsentInput,
  opts: { revokeAll?: boolean } = {},
): Promise<TelemetryConsent> {
  const existing = await db
    .select()
    .from(telemetrySettings)
    .where(tenantScope(ctx, telemetrySettings))
    .limit(1);
  const prev = existing[0] ?? null;

  const nowMs = Date.now();
  const merged = mergeConsent(prev, input, opts.revokeAll ?? false, nowMs);

  if (prev) {
    await db
      .update(telemetrySettings)
      .set({
        optInUsage: merged.optInUsage,
        optInPerformance: merged.optInPerformance,
        optInCrashes: merged.optInCrashes,
        optInOnboarding: merged.optInOnboarding,
        optInMarketplace: merged.optInMarketplace,
        consentGivenAt: merged.consentGivenAt,
        consentRevokedAt: merged.consentRevokedAt,
        updatedAt: nowMs,
        version: prev.version + 1,
      })
      .where(
        and(
          tenantScope(ctx, telemetrySettings),
          eq(telemetrySettings.version, prev.version),
        ),
      );
  } else {
    await db.insert(telemetrySettings).values(
      withTenantValues(ctx, {
        id: ctx.tenantId,
        anonymousId: merged.anonymousId,
        optInUsage: merged.optInUsage,
        optInPerformance: merged.optInPerformance,
        optInCrashes: merged.optInCrashes,
        optInOnboarding: merged.optInOnboarding,
        optInMarketplace: merged.optInMarketplace,
        consentGivenAt: merged.consentGivenAt,
        consentRevokedAt: merged.consentRevokedAt,
        createdAt: nowMs,
        updatedAt: nowMs,
        version: 1,
      }),
    );
  }

  return {
    optInUsage: merged.optInUsage === 1,
    optInPerformance: merged.optInPerformance === 1,
    optInCrashes: merged.optInCrashes === 1,
    optInOnboarding: merged.optInOnboarding === 1,
    optInMarketplace: merged.optInMarketplace === 1,
    anonymousId: merged.anonymousId,
    consentGivenAt:
      merged.consentGivenAt !== null
        ? new Date(merged.consentGivenAt).toISOString()
        : null,
    consentRevokedAt:
      merged.consentRevokedAt !== null
        ? new Date(merged.consentRevokedAt).toISOString()
        : null,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

interface MergedConsent {
  optInUsage: number;
  optInPerformance: number;
  optInCrashes: number;
  optInOnboarding: number;
  optInMarketplace: number;
  anonymousId: string;
  consentGivenAt: number | null;
  consentRevokedAt: number | null;
}

function mergeConsent(
  prev: typeof telemetrySettings.$inferSelect | null,
  patch: TelemetryConsentInput,
  revokeAll: boolean,
  nowMs: number,
): MergedConsent {
  const pick = (
    next: boolean | undefined,
    current: number,
  ): number => (revokeAll ? 0 : next === undefined ? current : next ? 1 : 0);
  const merged: MergedConsent = {
    optInUsage: pick(patch.optInUsage, prev?.optInUsage ?? 0),
    optInPerformance: pick(patch.optInPerformance, prev?.optInPerformance ?? 0),
    optInCrashes: pick(patch.optInCrashes, prev?.optInCrashes ?? 0),
    optInOnboarding: pick(patch.optInOnboarding, prev?.optInOnboarding ?? 0),
    optInMarketplace: pick(patch.optInMarketplace, prev?.optInMarketplace ?? 0),
    anonymousId: prev?.anonymousId ?? `anon_${nanoid(16)}`,
    consentGivenAt: prev?.consentGivenAt ?? null,
    consentRevokedAt: prev?.consentRevokedAt ?? null,
  };
  const anyOn =
    merged.optInUsage === 1 ||
    merged.optInPerformance === 1 ||
    merged.optInCrashes === 1 ||
    merged.optInOnboarding === 1 ||
    merged.optInMarketplace === 1;
  if (anyOn && merged.consentGivenAt === null) merged.consentGivenAt = nowMs;
  if (!anyOn) merged.consentRevokedAt = nowMs;
  if (revokeAll) merged.consentRevokedAt = nowMs;
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────
// Event recording
// ─────────────────────────────────────────────────────────────────────────

const CATEGORY_TO_FLAG: Record<TelemetryCategory, keyof TelemetryConsent> = {
  feature_usage: "optInUsage",
  performance: "optInPerformance",
  onboarding: "optInOnboarding",
  marketplace: "optInMarketplace",
};

function isCategoryConsented(consent: TelemetryConsent, category: TelemetryCategory): boolean {
  const flag = CATEGORY_TO_FLAG[category];
  return consent[flag] === true;
}

export async function recordTelemetryEvents(
  ctx: TenantContext,
  inputs: ReadonlyArray<TelemetryEventInput>,
): Promise<TelemetryRecordResult> {
  const consent = await getTelemetryConsent(ctx);
  const result: TelemetryRecordResult = {
    accepted: 0,
    rejected: 0,
    rejections: [],
    records: [],
  };

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    if (!TELEMETRY_CATEGORIES.includes(input.category)) {
      result.rejected++;
      result.rejections.push({ index: i, reason: `unknown category "${input.category}"` });
      continue;
    }
    if (!isCategoryConsented(consent, input.category)) {
      result.rejected++;
      result.rejections.push({ index: i, reason: `consent denied: ${input.category}` });
      continue;
    }
    let cleanPayload: Record<string, unknown>;
    try {
      cleanPayload = sanitizeTelemetryPayload(input.payload ?? {}, "payload");
    } catch (e) {
      result.rejected++;
      const msg = e instanceof Error ? e.message : String(e);
      result.rejections.push({ index: i, reason: msg });
      continue;
    }

    const id = `tev_${nanoid()}`;
    const nowMs = Date.now();
    try {
      await db.insert(telemetryEvents).values(
        withTenantValues(ctx, {
          id,
          anonymousId: consent.anonymousId,
          category: input.category,
          eventName: input.eventName,
          payload: JSON.stringify(cleanPayload),
          opVersion: input.opVersion ?? "0.1.0",
          osPlatform: input.osPlatform ?? null,
          hardwareTier: input.hardwareTier ?? null,
          durationMs: input.durationMs ?? null,
          createdAt: nowMs,
          updatedAt: nowMs,
        }),
      );
      result.accepted++;
      result.records.push({
        id,
        category: input.category,
        eventName: input.eventName,
        payload: cleanPayload,
        opVersion: input.opVersion ?? "0.1.0",
        osPlatform: input.osPlatform ?? null,
        hardwareTier: input.hardwareTier ?? null,
        durationMs: input.durationMs ?? null,
        anonymousId: consent.anonymousId,
        createdAt: new Date(nowMs).toISOString(),
      });
    } catch (e) {
      logger.error({ err: e, eventName: input.eventName }, "Failed to record telemetry event");
      result.rejected++;
      result.rejections.push({ index: i, reason: "persist failed" });
    }
  }

  return result;
}

function rowToEvent(r: typeof telemetryEvents.$inferSelect): TelemetryEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.payload) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    category: r.category,
    eventName: r.eventName,
    payload,
    opVersion: r.opVersion,
    osPlatform: r.osPlatform,
    hardwareTier: r.hardwareTier,
    durationMs: r.durationMs,
    anonymousId: r.anonymousId,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function listTelemetryEvents(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number; category?: TelemetryCategory } = {},
): Promise<PaginatedData<TelemetryEventRecord>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const conditions = [tenantScope(ctx, telemetryEvents)];
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(telemetryEvents.createdAt, cursorTs));
  }
  if (opts.category) {
    conditions.push(eq(telemetryEvents.category, opts.category));
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions)!;

  const rows = await db
    .select()
    .from(telemetryEvents)
    .where(where)
    .orderBy(desc(telemetryEvents.createdAt))
    .limit(limit + 1);

  return buildPage(rows.map(rowToEvent), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Crash reports
// ─────────────────────────────────────────────────────────────────────────

function rowToCrash(r: typeof crashReports.$inferSelect): CrashReportRecord {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    message: r.message,
    stackTrace: r.stackTrace,
    breadcrumbs: r.breadcrumbs,
    opVersion: r.opVersion,
    osPlatform: r.osPlatform,
    osVersion: r.osVersion,
    hardwareTier: r.hardwareTier,
    anonymousId: r.anonymousId,
    submittedAt: r.submittedAt !== null ? new Date(r.submittedAt).toISOString() : null,
    githubIssueUrl: r.githubIssueUrl,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

function fingerprintFor(message: string, stack: string | null): string {
  const trimmed = `${message}\n${stack ?? ""}`.slice(0, 400);
  // Simple stable hash — sufficient for grouping; not cryptographic.
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) {
    h = (h * 31 + trimmed.charCodeAt(i)) | 0;
  }
  return `crash_${Math.abs(h).toString(36)}`;
}

export async function submitCrashReport(
  ctx: TenantContext,
  input: CrashReportInput,
): Promise<CrashReportRecord> {
  const consent = await getTelemetryConsent(ctx);
  if (!consent.optInCrashes) {
    throw new TelemetryConsentDeniedError("crashes");
  }

  // Sanitize the message itself (it may legitimately contain a path).
  const safeMessage = sanitizeStackTrace(input.message) ?? "(empty)";
  const safeStack = sanitizeStackTrace(input.stackTrace ?? null);
  const safeBreadcrumbs = sanitizeStackTrace(input.breadcrumbs ?? null);
  const fingerprint = input.fingerprint ?? fingerprintFor(safeMessage, safeStack);

  const id = `cr_${nanoid()}`;
  const nowMs = Date.now();
  await db.insert(crashReports).values(
    withTenantValues(ctx, {
      id,
      anonymousId: consent.anonymousId,
      fingerprint,
      message: safeMessage,
      stackTrace: safeStack,
      breadcrumbs: safeBreadcrumbs,
      opVersion: input.opVersion ?? "0.1.0",
      osPlatform: input.osPlatform ?? null,
      osVersion: input.osVersion ?? null,
      hardwareTier: input.hardwareTier ?? null,
      submittedAt: nowMs,
      githubIssueUrl: null,
      createdAt: nowMs,
      updatedAt: nowMs,
      version: 1,
    }),
  );

  return {
    id,
    fingerprint,
    message: safeMessage,
    stackTrace: safeStack,
    breadcrumbs: safeBreadcrumbs,
    opVersion: input.opVersion ?? "0.1.0",
    osPlatform: input.osPlatform ?? null,
    osVersion: input.osVersion ?? null,
    hardwareTier: input.hardwareTier ?? null,
    anonymousId: consent.anonymousId,
    submittedAt: new Date(nowMs).toISOString(),
    githubIssueUrl: null,
    createdAt: new Date(nowMs).toISOString(),
  };
}

export async function listCrashReports(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<CrashReportRecord>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, crashReports);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(crashReports.createdAt, cursorTs))!
      : baseScope;

  const rows = await db
    .select()
    .from(crashReports)
    .where(where)
    .orderBy(desc(crashReports.createdAt))
    .limit(limit + 1);

  return buildPage(rows.map(rowToCrash), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Erasure (settings + events + crashes)
// ─────────────────────────────────────────────────────────────────────────

export interface TelemetryErasureReceipt {
  eventsDeleted: number;
  crashesDeleted: number;
  settingsCleared: boolean;
  scheduledAt: string;
}

/**
 * Hard-delete every telemetry artefact owned by this tenant. Used by both
 * the "Delete my telemetry data" button in the Settings card and the
 * tenant-wide GDPR erasure path. Safe to call repeatedly (idempotent).
 */
export async function eraseTelemetryData(
  ctx: TenantContext,
): Promise<TelemetryErasureReceipt> {
  const eventsBefore = await db
    .select({ id: telemetryEvents.id })
    .from(telemetryEvents)
    .where(tenantScope(ctx, telemetryEvents));
  await db.delete(telemetryEvents).where(tenantScope(ctx, telemetryEvents));

  const crashesBefore = await db
    .select({ id: crashReports.id })
    .from(crashReports)
    .where(tenantScope(ctx, crashReports));
  await db.delete(crashReports).where(tenantScope(ctx, crashReports));

  const settingsBefore = await db
    .select({ id: telemetrySettings.id })
    .from(telemetrySettings)
    .where(tenantScope(ctx, telemetrySettings));
  await db.delete(telemetrySettings).where(tenantScope(ctx, telemetrySettings));

  return {
    eventsDeleted: eventsBefore.length,
    crashesDeleted: crashesBefore.length,
    settingsCleared: settingsBefore.length > 0,
    scheduledAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Dashboard summary (per-tenant — cross-tenant aggregation requires the
// privileged admin role that lands in Task #7).
// ─────────────────────────────────────────────────────────────────────────

const ONBOARDING_FUNNEL_STEPS: readonly string[] = [
  "wizard_started",
  "wizard_user_type",
  "wizard_use_case",
  "wizard_hardware_probed",
  "wizard_completed",
  "first_task_completed",
];

export async function getTelemetrySummary(
  ctx: TenantContext,
): Promise<TelemetrySummary> {
  const eventsScope = tenantScope(ctx, telemetryEvents);
  const crashesScope = tenantScope(ctx, crashReports);

  const totalEventsRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(telemetryEvents)
    .where(eventsScope);
  const totalCrashesRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(crashReports)
    .where(crashesScope);
  const uniqueAnonRows = await db
    .select({ count: sql<number>`count(distinct anonymous_id)` })
    .from(telemetryEvents)
    .where(eventsScope);

  const categoryRows = await db
    .select({
      category: telemetryEvents.category,
      count: sql<number>`count(*)`,
    })
    .from(telemetryEvents)
    .where(eventsScope)
    .groupBy(telemetryEvents.category);

  const eventNameRows = await db
    .select({
      eventName: telemetryEvents.eventName,
      count: sql<number>`count(*)`,
    })
    .from(telemetryEvents)
    .where(eventsScope)
    .groupBy(telemetryEvents.eventName)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const tierRows = await db
    .select({
      tier: telemetryEvents.hardwareTier,
      count: sql<number>`count(*)`,
    })
    .from(telemetryEvents)
    .where(eventsScope)
    .groupBy(telemetryEvents.hardwareTier);

  const crashFingerprintRows = await db
    .select({
      fingerprint: crashReports.fingerprint,
      count: sql<number>`count(*)`,
      lastSeenAt: sql<number>`max(created_at)`,
    })
    .from(crashReports)
    .where(crashesScope)
    .groupBy(crashReports.fingerprint)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Onboarding funnel — count distinct anonymousIds per named step.
  const onboardingRows = await db
    .select({
      eventName: telemetryEvents.eventName,
      count: sql<number>`count(distinct anonymous_id)`,
    })
    .from(telemetryEvents)
    .where(and(eventsScope, eq(telemetryEvents.category, "onboarding"))!)
    .groupBy(telemetryEvents.eventName);

  const onboardingByName = new Map<string, number>();
  for (const r of onboardingRows) onboardingByName.set(r.eventName, Number(r.count));

  return {
    totalEvents: Number(totalEventsRows[0]?.count ?? 0),
    totalCrashes: Number(totalCrashesRows[0]?.count ?? 0),
    uniqueAnonymousIds: Number(uniqueAnonRows[0]?.count ?? 0),
    categoryCounts: categoryRows.map((r) => ({
      category: r.category,
      count: Number(r.count),
    })),
    topEventNames: eventNameRows.map((r) => ({
      eventName: r.eventName,
      count: Number(r.count),
    })),
    hardwareTierCounts: tierRows
      .filter((r) => r.tier !== null)
      .map((r) => ({ tier: String(r.tier), count: Number(r.count) })),
    onboardingFunnel: ONBOARDING_FUNNEL_STEPS.map((step) => ({
      step,
      count: onboardingByName.get(step) ?? 0,
    })),
    topCrashFingerprints: crashFingerprintRows.map((r) => ({
      fingerprint: r.fingerprint,
      count: Number(r.count),
      lastSeenAt: new Date(Number(r.lastSeenAt)).toISOString(),
    })),
    generatedAt: new Date().toISOString(),
  };
}
