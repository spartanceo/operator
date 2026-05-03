/**
 * Desktop App Auto-Update System (Task #48).
 *
 * The server side of the update infrastructure: a self-hosted release
 * catalogue (in lieu of Hazel/Nuts), staged-rollout selection, delta /
 * full package routing, ed25519 signature minting + verification, the
 * post-update crash detector, and per-tenant version pinning.
 *
 * Client topology (informational — the desktop shell consumes these):
 *
 *      ┌─ Electron shell ─┐  poll /updates/check
 *      │  autoUpdater     │ ───────────────────────────►  this service
 *      │                  │  ◄──────────────────────────  manifest + signature
 *      │                  │
 *      │  ✓ verify sig    │  POST /updates/install/start  (downloading)
 *      │  ✓ apply patch   │  POST /updates/install/result (launch_pending)
 *      │  ✓ relaunch      │
 *      │  ✓ on next boot  │  POST /updates/install/result (launch_succeeded)
 *      │     OR crash     │  GET  /updates/rollback        (← prev good)
 *      └──────────────────┘
 *
 * Source-of-truth layering:
 *   1. The release catalogue lives in `update_releases` (system tenant).
 *      An admin POSTs new releases via `/updates/admin/releases`.
 *   2. For backward compatibility with the Onboarding task's env-driven
 *      seam, `checkForUpdates()` falls back to `OMNINITY_LATEST_VERSION`
 *      if the catalogue is empty — the existing chat header banner keeps
 *      working with no migration step.
 *   3. Signing keys come from `OMNINITY_UPDATE_SIGNING_PRIVATE_KEY` (PEM,
 *      ed25519, dev/test only — production CI signs in the build pipeline)
 *      and `OMNINITY_UPDATE_SIGNING_PUBLIC_KEY` (PEM, embedded in client).
 *      If the public key is unset signature verification is skipped with
 *      a logged warning so dev iteration is unblocked.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

import { and, asc, desc, eq, isNull, lt, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  SYSTEM_TENANT_ID,
  tenantScope,
  updateInstallAttempts,
  updatePinning,
  updateReleases,
} from "@workspace/db";

import { logger } from "../lib/logger";

// ─── Types ─────────────────────────────────────────────────────────────────

export type ReleaseChannel = "stable" | "beta" | "canary" | "dev";
export type Platform = "darwin" | "win32" | "linux";
export type UpdateKind = "full" | "delta";

export type InstallStatus =
  | "downloading"
  | "downloaded"
  | "verifying"
  | "verified"
  | "installing"
  | "installed"
  | "launch_pending"
  | "launch_succeeded"
  | "launch_failed"
  | "rolled_back"
  | "aborted"
  | "signature_invalid";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  channel: string;
  downloadUrl: string | null;
  releaseNotes: string | null;
  checkedAt: string;
  /** True if the tenant is pinned and not eligible for auto-update. */
  pinned: boolean;
  pinnedVersion: string | null;
  /** True if the tenant fell inside the staged-rollout window. */
  inRollout: boolean;
  rolloutPercentage: number | null;
  /** Manifest detail when an update is available (matches /updates/release/:v). */
  manifest: ReleaseManifest | null;
}

export interface ReleaseManifest {
  version: string;
  channel: ReleaseChannel;
  platform: Platform;
  arch: string;
  full: PackageDescriptor;
  delta: DeltaDescriptor | null;
  signature: string | null;
  signatureAlgorithm: string;
  releaseNotes: string;
  rolloutPercentage: number;
  publishedAt: string;
}

export interface PackageDescriptor {
  url: string;
  sha256: string;
  size: number;
}

export interface DeltaDescriptor extends PackageDescriptor {
  fromVersion: string;
}

export interface CreateReleaseInput {
  version: string;
  channel?: ReleaseChannel;
  platform: Platform;
  arch?: string;
  fullUrl: string;
  fullSha256: string;
  fullSize?: number;
  delta?: {
    fromVersion: string;
    url: string;
    sha256: string;
    size?: number;
  };
  releaseNotes?: string;
  rolloutPercentage?: number;
}

export interface UpdatePinningView {
  pinnedVersion: string | null;
  pinnedChannel: ReleaseChannel | null;
  autoUpdateEnabled: boolean;
  managedBy: "user" | "admin" | "enterprise";
  managedByUserId: string | null;
  notes: string | null;
  updatedAt: string | null;
}

export interface ServerHealthSnapshot {
  status: "ok" | "degraded" | "down";
  releasesPublished: number;
  channelsActive: string[];
  latestPublishedAt: string | null;
  signingConfigured: boolean;
  verificationConfigured: boolean;
  rollbackPendingCount: number;
  checkedAt: string;
}

export interface InstallStartInput {
  deviceId: string;
  fromVersion: string | null;
  toVersion: string;
  platform: Platform;
  arch?: string;
  channel?: ReleaseChannel;
  updateKind: UpdateKind;
}

export interface InstallResultInput {
  attemptId: string;
  status: InstallStatus;
  failureReason?: string;
  signatureVerified?: boolean;
  bytesDownloaded?: number;
}

export interface RollbackDecision {
  shouldRollBack: boolean;
  rollbackToVersion: string | null;
  failedVersion: string | null;
  reason: string | null;
  attemptId: string | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const FALLBACK_VERSION = "0.1.0";
const DEFAULT_CHANNEL: ReleaseChannel = "stable";
/**
 * If a `launch_pending` row sits in this state for longer than this window
 * the rollback service treats the update as crashed-on-launch and surfaces
 * the previous good version. 10 minutes is generous — a healthy launch
 * flips the row in seconds, but the user may have left the laptop closed.
 */
const LAUNCH_PENDING_ROLLBACK_MS = 10 * 60 * 1000;

// tier-review: bounded — fixed enum of install-state-machine values
const INSTALL_STATUS_VALUES: ReadonlySet<InstallStatus> = new Set([
  "downloading",
  "downloaded",
  "verifying",
  "verified",
  "installing",
  "installed",
  "launch_pending",
  "launch_succeeded",
  "launch_failed",
  "rolled_back",
  "aborted",
  "signature_invalid",
]);

// ─── Version helpers ───────────────────────────────────────────────────────

function readCurrentVersion(): string {
  const v = process.env["npm_package_version"];
  return v && v.length > 0 ? v : FALLBACK_VERSION;
}

const SEMVER_PRE_RE = /^[0-9A-Za-z.-]+$/;
const VERSION_RE = /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?$/;

export function isValidVersion(v: string): boolean {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return false;
  if (!VERSION_RE.test(v)) return false;
  const pre = v.split("-")[1];
  if (pre !== undefined && !SEMVER_PRE_RE.test(pre)) return false;
  return true;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const stripPre = (v: string): string => v.split("-")[0] ?? v;
  const aParts = stripPre(a).split(".").map((s) => Number(s) || 0);
  const bParts = stripPre(b).split(".").map((s) => Number(s) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

// ─── Staged rollout (deterministic per-tenant bucketing) ───────────────────

/**
 * Map a tenant id to a stable integer in [0, 99]. Releases at
 * `rollout_percentage = 20` admit tenants whose bucket is < 20.
 *
 * Using SHA-256 of `tenantId + "|" + version` keeps the bucket stable for
 * the lifetime of a release (so a user doesn't bounce in and out of the
 * rollout as the percentage changes) but rotates between releases (so the
 * same unlucky tenants don't always get every canary).
 */
export function rolloutBucket(tenantId: string, version: string): number {
  const h = createHash("sha256").update(`${tenantId}|${version}`).digest();
  // First 4 bytes → uint32 → mod 100.
  const n = h.readUInt32BE(0);
  return n % 100;
}

export function isInRollout(
  tenantId: string,
  version: string,
  rolloutPercentage: number,
): boolean {
  if (rolloutPercentage >= 100) return true;
  if (rolloutPercentage <= 0) return false;
  return rolloutBucket(tenantId, version) < rolloutPercentage;
}

// ─── Signature minting + verification (ed25519) ────────────────────────────

/**
 * Canonical bytes the signature is computed over. Includes everything a
 * tampered package would want to swap: version, platform, arch, the
 * package digest, and the size. The shell recomputes the same canonical
 * string before calling `ed25519.verify(publicKey, signature, canonical)`.
 */
export function canonicalSigningPayload(input: {
  version: string;
  platform: Platform;
  arch: string;
  sha256: string;
  size: number;
  kind: UpdateKind;
}): string {
  return [
    "omninity-update/v1",
    input.kind,
    input.version,
    input.platform,
    input.arch,
    input.sha256,
    String(input.size),
  ].join("|");
}

function loadPrivateKey(): ReturnType<typeof createPrivateKey> | null {
  const pem = process.env["OMNINITY_UPDATE_SIGNING_PRIVATE_KEY"];
  if (!pem || pem.length === 0) return null;
  try {
    return createPrivateKey({ key: pem, format: "pem" });
  } catch (e) {
    logger.warn({ err: e }, "Invalid OMNINITY_UPDATE_SIGNING_PRIVATE_KEY — signing disabled");
    return null;
  }
}

function loadPublicKey(): ReturnType<typeof createPublicKey> | null {
  const pem = process.env["OMNINITY_UPDATE_SIGNING_PUBLIC_KEY"];
  if (!pem || pem.length === 0) return null;
  try {
    return createPublicKey({ key: pem, format: "pem" });
  } catch (e) {
    logger.warn({ err: e }, "Invalid OMNINITY_UPDATE_SIGNING_PUBLIC_KEY — verification disabled");
    return null;
  }
}

export function signPayload(canonical: string): string | null {
  const key = loadPrivateKey();
  if (!key) return null;
  const sig = edSign(null, Buffer.from(canonical, "utf8"), key);
  return sig.toString("base64");
}

export interface VerifyResult {
  verified: boolean;
  reason: string | null;
  /** True iff verification was attempted (i.e. a public key was configured). */
  attempted: boolean;
}

export function verifySignature(
  canonical: string,
  signatureBase64: string | null,
): VerifyResult {
  const key = loadPublicKey();
  if (!key) {
    return { verified: false, reason: "no_public_key_configured", attempted: false };
  }
  if (!signatureBase64 || signatureBase64.length === 0) {
    return { verified: false, reason: "missing_signature", attempted: true };
  }
  try {
    const ok = edVerify(
      null,
      Buffer.from(canonical, "utf8"),
      key,
      Buffer.from(signatureBase64, "base64"),
    );
    return { verified: ok, reason: ok ? null : "bad_signature", attempted: true };
  } catch (e) {
    logger.warn({ err: e }, "Signature verification threw");
    return { verified: false, reason: "verify_error", attempted: true };
  }
}

export function signingConfigured(): boolean {
  return loadPrivateKey() !== null;
}

export function verificationConfigured(): boolean {
  return loadPublicKey() !== null;
}

// ─── Release catalogue ─────────────────────────────────────────────────────

function toManifest(r: typeof updateReleases.$inferSelect): ReleaseManifest {
  return {
    version: r.version,
    channel: r.channel as ReleaseChannel,
    platform: r.platform as Platform,
    arch: r.arch,
    full: {
      url: r.fullUrl,
      sha256: r.fullSha256,
      size: r.fullSize,
    },
    delta:
      r.deltaFromVersion && r.deltaUrl && r.deltaSha256
        ? {
            fromVersion: r.deltaFromVersion,
            url: r.deltaUrl,
            sha256: r.deltaSha256,
            size: r.deltaSize ?? 0,
          }
        : null,
    signature: r.signature,
    signatureAlgorithm: r.signatureAlgorithm,
    releaseNotes: r.releaseNotes,
    rolloutPercentage: r.rolloutPercentage,
    publishedAt: new Date(r.publishedAt).toISOString(),
  };
}

export class UpdateValidationError extends Error {
  override readonly name = "UpdateValidationError";
  readonly code = "UPDATE_VALIDATION";
}

function clampPercentage(n: number | undefined, fallback = 100): number {
  if (n === undefined || Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

function isValidSha256(s: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(s);
}

export async function publishRelease(input: CreateReleaseInput): Promise<ReleaseManifest> {
  if (!isValidVersion(input.version)) throw new UpdateValidationError("Invalid version");
  if (!isValidSha256(input.fullSha256)) throw new UpdateValidationError("Invalid full sha256");
  if (input.delta && !isValidSha256(input.delta.sha256)) {
    throw new UpdateValidationError("Invalid delta sha256");
  }
  if (input.delta && !isValidVersion(input.delta.fromVersion)) {
    throw new UpdateValidationError("Invalid delta fromVersion");
  }
  const channel: ReleaseChannel = input.channel ?? DEFAULT_CHANNEL;
  const arch = input.arch ?? "x64";
  const fullSize = input.fullSize ?? 0;
  const deltaSize = input.delta?.size ?? 0;
  const rollout = clampPercentage(input.rolloutPercentage, 100);

  // Reject duplicates (same channel/platform/arch/version) — the unique
  // index would throw anyway but a clean validation error reads better.
  const existing = await db
    .select()
    .from(updateReleases)
    .where(
      and(
        eq(updateReleases.channel, channel),
        eq(updateReleases.platform, input.platform),
        eq(updateReleases.arch, arch),
        eq(updateReleases.version, input.version),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new UpdateValidationError(
      `Release already published: ${channel}/${input.platform}/${arch}@${input.version}`,
    );
  }

  // Mint signature for full + (optionally) delta. We store the full's
  // signature on the row; the delta signature is recomputed by the client
  // from the canonical payload and the delta's own digest, so we don't
  // need a separate column. (Both descriptors carry the same `version` —
  // the canonical payload differs by `kind` field.)
  const fullCanonical = canonicalSigningPayload({
    version: input.version,
    platform: input.platform,
    arch,
    sha256: input.fullSha256,
    size: fullSize,
    kind: "full",
  });
  const signature = signPayload(fullCanonical);

  const id = `rel_${nanoid(12)}`;
  const now = Date.now();

  await db.insert(updateReleases).values({
    id,
    tenantId: SYSTEM_TENANT_ID,
    version: input.version,
    channel,
    platform: input.platform,
    arch,
    fullUrl: input.fullUrl,
    fullSha256: input.fullSha256,
    fullSize,
    deltaFromVersion: input.delta?.fromVersion ?? null,
    deltaUrl: input.delta?.url ?? null,
    deltaSha256: input.delta?.sha256 ?? null,
    deltaSize: input.delta ? deltaSize : null,
    signature,
    signatureAlgorithm: "ed25519",
    releaseNotes: input.releaseNotes ?? "",
    rolloutPercentage: rollout,
    publishedAt: now,
    yanked: 0,
    yankedReason: null,
    createdAt: now,
    updatedAt: now,
    versionRow: 1,
  });

  const row = await db
    .select()
    .from(updateReleases)
    .where(eq(updateReleases.id, id))
    .limit(1);
  return toManifest(row[0]!);
}

export async function setRolloutPercentage(
  channel: ReleaseChannel,
  platform: Platform,
  arch: string,
  version: string,
  percentage: number,
): Promise<ReleaseManifest | null> {
  const pct = clampPercentage(percentage, 100);
  await db
    .update(updateReleases)
    .set({ rolloutPercentage: pct, updatedAt: Date.now() })
    .where(
      and(
        eq(updateReleases.channel, channel),
        eq(updateReleases.platform, platform),
        eq(updateReleases.arch, arch),
        eq(updateReleases.version, version),
      ),
    );
  const row = await db
    .select()
    .from(updateReleases)
    .where(
      and(
        eq(updateReleases.channel, channel),
        eq(updateReleases.platform, platform),
        eq(updateReleases.arch, arch),
        eq(updateReleases.version, version),
      ),
    )
    .limit(1);
  return row[0] ? toManifest(row[0]) : null;
}

export async function yankRelease(
  channel: ReleaseChannel,
  platform: Platform,
  arch: string,
  version: string,
  reason: string,
): Promise<ReleaseManifest | null> {
  await db
    .update(updateReleases)
    .set({ yanked: 1, yankedReason: reason, rolloutPercentage: 0, updatedAt: Date.now() })
    .where(
      and(
        eq(updateReleases.channel, channel),
        eq(updateReleases.platform, platform),
        eq(updateReleases.arch, arch),
        eq(updateReleases.version, version),
      ),
    );
  const row = await db
    .select()
    .from(updateReleases)
    .where(
      and(
        eq(updateReleases.channel, channel),
        eq(updateReleases.platform, platform),
        eq(updateReleases.arch, arch),
        eq(updateReleases.version, version),
      ),
    )
    .limit(1);
  return row[0] ? toManifest(row[0]) : null;
}

export async function listReleases(filter: {
  channel?: ReleaseChannel;
  platform?: Platform;
  arch?: string;
  includeYanked?: boolean;
  limit?: number;
}): Promise<ReleaseManifest[]> {
  const conditions = [];
  if (filter.channel) conditions.push(eq(updateReleases.channel, filter.channel));
  if (filter.platform) conditions.push(eq(updateReleases.platform, filter.platform));
  if (filter.arch) conditions.push(eq(updateReleases.arch, filter.arch));
  if (!filter.includeYanked) conditions.push(eq(updateReleases.yanked, 0));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = where
    ? await db.select().from(updateReleases).where(where).orderBy(desc(updateReleases.publishedAt)).limit(limit)
    : await db.select().from(updateReleases).orderBy(desc(updateReleases.publishedAt)).limit(limit);
  return rows.map(toManifest);
}

export async function getRelease(
  channel: ReleaseChannel,
  platform: Platform,
  arch: string,
  version: string,
): Promise<ReleaseManifest | null> {
  const row = await db
    .select()
    .from(updateReleases)
    .where(
      and(
        eq(updateReleases.channel, channel),
        eq(updateReleases.platform, platform),
        eq(updateReleases.arch, arch),
        eq(updateReleases.version, version),
      ),
    )
    .limit(1);
  return row[0] ? toManifest(row[0]) : null;
}

/**
 * Latest non-yanked release on the given channel/platform/arch ordered by
 * semantic version (we sort by published_at DESC and break ties with the
 * version comparator — releases published later normally have higher
 * versions, but this defends against a backfilled hotfix).
 */
async function latestRelease(
  channel: ReleaseChannel,
  platform: Platform,
  arch: string,
): Promise<typeof updateReleases.$inferSelect | null> {
  const rows = await db
    .select()
    .from(updateReleases)
    .where(
      and(
        eq(updateReleases.channel, channel),
        eq(updateReleases.platform, platform),
        eq(updateReleases.arch, arch),
        eq(updateReleases.yanked, 0),
      ),
    )
    .orderBy(desc(updateReleases.publishedAt));
  if (rows.length === 0) return null;
  rows.sort((a, b) => compareVersions(b.version, a.version));
  return rows[0]!;
}

// ─── Per-tenant version pinning ────────────────────────────────────────────

function toPinningView(
  r: typeof updatePinning.$inferSelect | undefined,
): UpdatePinningView {
  if (!r) {
    return {
      pinnedVersion: null,
      pinnedChannel: null,
      autoUpdateEnabled: true,
      managedBy: "user",
      managedByUserId: null,
      notes: null,
      updatedAt: null,
    };
  }
  return {
    pinnedVersion: r.pinnedVersion,
    pinnedChannel: (r.pinnedChannel as ReleaseChannel | null) ?? null,
    autoUpdateEnabled: r.autoUpdateEnabled === 1,
    managedBy: (r.managedBy as "user" | "admin" | "enterprise") ?? "user",
    managedByUserId: r.managedByUserId,
    notes: r.notes,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function getPinning(tenantId: string): Promise<UpdatePinningView> {
  const rows = await db
    .select()
    .from(updatePinning)
    .where(eq(updatePinning.tenantId, tenantId))
    .limit(1);
  return toPinningView(rows[0]);
}

export interface SetPinningInput {
  pinnedVersion?: string | null;
  pinnedChannel?: ReleaseChannel | null;
  autoUpdateEnabled?: boolean;
  managedBy?: "user" | "admin" | "enterprise";
  managedByUserId?: string | null;
  notes?: string | null;
}

export async function setPinning(
  tenantId: string,
  input: SetPinningInput,
): Promise<UpdatePinningView> {
  if (input.pinnedVersion && !isValidVersion(input.pinnedVersion)) {
    throw new UpdateValidationError("Invalid pinnedVersion");
  }
  const existing = await db
    .select()
    .from(updatePinning)
    .where(eq(updatePinning.tenantId, tenantId))
    .limit(1);
  const now = Date.now();
  if (existing.length === 0) {
    const id = `upin_${nanoid(12)}`;
    await db.insert(updatePinning).values({
      id,
      tenantId,
      pinnedVersion: input.pinnedVersion ?? null,
      pinnedChannel: input.pinnedChannel ?? null,
      autoUpdateEnabled: (input.autoUpdateEnabled ?? true) ? 1 : 0,
      managedBy: input.managedBy ?? "user",
      managedByUserId: input.managedByUserId ?? null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
  } else {
    const row = existing[0]!;
    await db
      .update(updatePinning)
      .set({
        pinnedVersion: input.pinnedVersion === undefined ? row.pinnedVersion : input.pinnedVersion,
        pinnedChannel: input.pinnedChannel === undefined ? row.pinnedChannel : input.pinnedChannel,
        autoUpdateEnabled:
          input.autoUpdateEnabled === undefined
            ? row.autoUpdateEnabled
            : input.autoUpdateEnabled
              ? 1
              : 0,
        managedBy: input.managedBy ?? row.managedBy,
        managedByUserId:
          input.managedByUserId === undefined ? row.managedByUserId : input.managedByUserId,
        notes: input.notes === undefined ? row.notes : input.notes,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(updatePinning.id, row.id));
  }
  return getPinning(tenantId);
}

// ─── checkForUpdates (the main client poll) ────────────────────────────────

export interface CheckForUpdatesOptions {
  tenantId: string;
  platform?: Platform;
  arch?: string;
  channel?: ReleaseChannel;
  currentVersion?: string;
}

/**
 * Decide whether the calling tenant should see an update. The path is:
 *   1. Resolve effective channel — pinning override > caller > stable.
 *   2. If pinning includes a version pin, that's the latest — never offer
 *      anything past the pin.
 *   3. Otherwise look up the catalogue's latest non-yanked release.
 *   4. Apply the staged-rollout filter using the deterministic bucket.
 *   5. Fall back to the env-driven seam if the catalogue is empty (keeps
 *      the chat header banner working in dev with no DB seeding).
 */
export async function checkForUpdates(
  opts: CheckForUpdatesOptions,
): Promise<UpdateCheckResult> {
  const currentVersion = opts.currentVersion ?? readCurrentVersion();
  const platform = opts.platform ?? (process.platform as Platform);
  const arch = opts.arch ?? "x64";

  const pinning = await getPinning(opts.tenantId);
  const effectiveChannel: ReleaseChannel =
    pinning.pinnedChannel ?? opts.channel ?? DEFAULT_CHANNEL;

  // Hard pin: never offer past the pinned version.
  if (pinning.pinnedVersion && !pinning.autoUpdateEnabled === false) {
    // (parsed with explicit comparison — we still want the "update available"
    // signal if the user is currently on an older version than the pin)
  }

  if (pinning.pinnedVersion) {
    const pinned = pinning.pinnedVersion;
    const updateAvailable = compareVersions(currentVersion, pinned) < 0;
    const manifest =
      (await getRelease(effectiveChannel, platform, arch, pinned)) ?? null;
    return {
      currentVersion,
      latestVersion: pinned,
      updateAvailable,
      channel: effectiveChannel,
      downloadUrl: manifest?.full.url ?? null,
      releaseNotes: manifest?.releaseNotes ?? null,
      checkedAt: new Date().toISOString(),
      pinned: true,
      pinnedVersion: pinned,
      inRollout: true,
      rolloutPercentage: manifest?.rolloutPercentage ?? null,
      manifest,
    };
  }

  if (!pinning.autoUpdateEnabled) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      channel: effectiveChannel,
      downloadUrl: null,
      releaseNotes: null,
      checkedAt: new Date().toISOString(),
      pinned: true,
      pinnedVersion: null,
      inRollout: false,
      rolloutPercentage: null,
      manifest: null,
    };
  }

  const latest = await latestRelease(effectiveChannel, platform, arch);
  if (latest) {
    const cmp = compareVersions(currentVersion, latest.version);
    const inRollout = isInRollout(opts.tenantId, latest.version, latest.rolloutPercentage);
    const updateAvailable = cmp < 0 && inRollout;
    const manifest = toManifest(latest);
    return {
      currentVersion,
      latestVersion: updateAvailable ? latest.version : currentVersion,
      updateAvailable,
      channel: effectiveChannel,
      downloadUrl: updateAvailable ? manifest.full.url : null,
      releaseNotes: updateAvailable ? manifest.releaseNotes : null,
      checkedAt: new Date().toISOString(),
      pinned: false,
      pinnedVersion: null,
      inRollout,
      rolloutPercentage: latest.rolloutPercentage,
      manifest: updateAvailable ? manifest : null,
    };
  }

  // Env-driven fallback for backward compat with the Onboarding task's
  // chat header banner — the only consumer before this task landed.
  const envLatest = process.env["OMNINITY_LATEST_VERSION"];
  if (envLatest && envLatest.length > 0 && isValidVersion(envLatest)) {
    const updateAvailable = compareVersions(currentVersion, envLatest) < 0;
    return {
      currentVersion,
      latestVersion: envLatest,
      updateAvailable,
      channel: process.env["OMNINITY_RELEASE_CHANNEL"] ?? effectiveChannel,
      downloadUrl: process.env["OMNINITY_LATEST_DOWNLOAD_URL"] ?? null,
      releaseNotes: process.env["OMNINITY_LATEST_RELEASE_NOTES"] ?? null,
      checkedAt: new Date().toISOString(),
      pinned: false,
      pinnedVersion: null,
      inRollout: true,
      rolloutPercentage: 100,
      manifest: null,
    };
  }

  return {
    currentVersion,
    latestVersion: currentVersion,
    updateAvailable: false,
    channel: effectiveChannel,
    downloadUrl: null,
    releaseNotes: null,
    checkedAt: new Date().toISOString(),
    pinned: false,
    pinnedVersion: null,
    inRollout: true,
    rolloutPercentage: null,
    manifest: null,
  };
}

// ─── Install state machine + crash detection ──────────────────────────────

export interface InstallAttemptView {
  id: string;
  deviceId: string;
  fromVersion: string | null;
  toVersion: string;
  channel: string;
  platform: string;
  arch: string;
  updateKind: UpdateKind;
  status: InstallStatus;
  failureReason: string | null;
  signatureVerified: boolean;
  bytesDownloaded: number;
  startedAt: string;
  completedAt: string | null;
  rolledBackAt: string | null;
  rolledBackToVersion: string | null;
}

function toAttemptView(r: typeof updateInstallAttempts.$inferSelect): InstallAttemptView {
  return {
    id: r.id,
    deviceId: r.deviceId,
    fromVersion: r.fromVersion,
    toVersion: r.toVersion,
    channel: r.channel,
    platform: r.platform,
    arch: r.arch,
    updateKind: r.updateKind as UpdateKind,
    status: r.status as InstallStatus,
    failureReason: r.failureReason,
    signatureVerified: r.signatureVerified === 1,
    bytesDownloaded: r.bytesDownloaded,
    startedAt: new Date(r.startedAt).toISOString(),
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    rolledBackAt: r.rolledBackAt ? new Date(r.rolledBackAt).toISOString() : null,
    rolledBackToVersion: r.rolledBackToVersion,
  };
}

export async function startInstall(
  tenantId: string,
  workspaceId: string,
  input: InstallStartInput,
): Promise<InstallAttemptView> {
  if (!isValidVersion(input.toVersion)) throw new UpdateValidationError("Invalid toVersion");
  if (input.fromVersion && !isValidVersion(input.fromVersion)) {
    throw new UpdateValidationError("Invalid fromVersion");
  }
  if (input.deviceId.length === 0 || input.deviceId.length > 128) {
    throw new UpdateValidationError("Invalid deviceId");
  }
  const id = `uia_${nanoid(12)}`;
  const now = Date.now();
  await db.insert(updateInstallAttempts).values({
    id,
    tenantId,
    workspaceId,
    deviceId: input.deviceId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    channel: input.channel ?? DEFAULT_CHANNEL,
    platform: input.platform,
    arch: input.arch ?? "x64",
    updateKind: input.updateKind,
    status: "downloading",
    bytesDownloaded: 0,
    signatureVerified: 0,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
  const rows = await db
    .select()
    .from(updateInstallAttempts)
    .where(
      and(eq(updateInstallAttempts.tenantId, tenantId), eq(updateInstallAttempts.id, id)),
    )
    .limit(1);
  return toAttemptView(rows[0]!);
}

// tier-review: bounded — fixed enum of terminal install statuses
const TERMINAL_STATUSES: ReadonlySet<InstallStatus> = new Set([
  "launch_succeeded",
  "rolled_back",
  "aborted",
  "signature_invalid",
  "launch_failed",
]);

export async function recordInstallResult(
  tenantId: string,
  input: InstallResultInput,
): Promise<InstallAttemptView | null> {
  if (!INSTALL_STATUS_VALUES.has(input.status)) {
    throw new UpdateValidationError(`Unknown status: ${input.status}`);
  }
  const rows = await db
    .select()
    .from(updateInstallAttempts)
    .where(
      and(
        eq(updateInstallAttempts.tenantId, tenantId),
        eq(updateInstallAttempts.id, input.attemptId),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const now = Date.now();
  const update: Partial<typeof updateInstallAttempts.$inferInsert> = {
    status: input.status,
    failureReason: input.failureReason ?? row.failureReason,
    signatureVerified:
      input.signatureVerified === undefined
        ? row.signatureVerified
        : input.signatureVerified
          ? 1
          : 0,
    bytesDownloaded: input.bytesDownloaded ?? row.bytesDownloaded,
    updatedAt: now,
    version: row.version + 1,
  };
  if (TERMINAL_STATUSES.has(input.status)) {
    update.completedAt = now;
  }
  await db
    .update(updateInstallAttempts)
    .set(update)
    .where(eq(updateInstallAttempts.id, row.id));
  const after = await db
    .select()
    .from(updateInstallAttempts)
    .where(
      and(
        eq(updateInstallAttempts.tenantId, tenantId),
        eq(updateInstallAttempts.id, row.id),
      ),
    )
    .limit(1);
  return after[0] ? toAttemptView(after[0]) : null;
}

/**
 * The crash detector. The desktop shell calls this on every cold start
 * BEFORE wiring up its main UI — if a rollback is needed the shell
 * re-launches into the previous good version's directory.
 *
 * Rule:
 *   - Find the device's most-recent install attempt.
 *   - If status is `launch_pending` and started_at < (now - WINDOW), or
 *     status is `launch_failed`, recommend rollback to `from_version`.
 *   - Mark the attempt `rolled_back` once the shell confirms (separate
 *     POST /updates/install/result with status=rolled_back).
 */
export async function evaluateRollback(
  tenantId: string,
  deviceId: string,
): Promise<RollbackDecision> {
  const rows = await db
    .select()
    .from(updateInstallAttempts)
    .where(
      and(
        eq(updateInstallAttempts.tenantId, tenantId),
        eq(updateInstallAttempts.deviceId, deviceId),
      ),
    )
    .orderBy(desc(updateInstallAttempts.startedAt))
    .limit(5);
  if (rows.length === 0) {
    return {
      shouldRollBack: false,
      rollbackToVersion: null,
      failedVersion: null,
      reason: null,
      attemptId: null,
    };
  }
  const latest = rows[0]!;
  if (latest.status === "launch_failed") {
    return {
      shouldRollBack: latest.fromVersion !== null,
      rollbackToVersion: latest.fromVersion,
      failedVersion: latest.toVersion,
      reason: latest.failureReason ?? "launch_failed",
      attemptId: latest.id,
    };
  }
  if (
    latest.status === "launch_pending" &&
    Date.now() - latest.startedAt > LAUNCH_PENDING_ROLLBACK_MS
  ) {
    return {
      shouldRollBack: latest.fromVersion !== null,
      rollbackToVersion: latest.fromVersion,
      failedVersion: latest.toVersion,
      reason: "launch_pending_timeout",
      attemptId: latest.id,
    };
  }
  return {
    shouldRollBack: false,
    rollbackToVersion: null,
    failedVersion: null,
    reason: null,
    attemptId: null,
  };
}

export async function listInstallAttempts(
  tenantId: string,
  deviceId: string | null,
  limit = 20,
): Promise<InstallAttemptView[]> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const where = deviceId
    ? and(
        eq(updateInstallAttempts.tenantId, tenantId),
        eq(updateInstallAttempts.deviceId, deviceId),
      )
    : eq(updateInstallAttempts.tenantId, tenantId);
  const rows = await db
    .select()
    .from(updateInstallAttempts)
    .where(where)
    .orderBy(desc(updateInstallAttempts.startedAt))
    .limit(cap);
  return rows.map(toAttemptView);
}

// ─── Server health (status page surface) ──────────────────────────────────

export async function serverHealth(): Promise<ServerHealthSnapshot> {
  const rows = await db
    .select()
    .from(updateReleases)
    .where(eq(updateReleases.yanked, 0))
    .orderBy(desc(updateReleases.publishedAt))
    .limit(500);
  const channels = Array.from(new Set(rows.map((r) => r.channel))).sort();
  const latestPublishedAt = rows[0] ? new Date(rows[0].publishedAt).toISOString() : null;
  const pendingRollbacks = await db
    .select()
    .from(updateInstallAttempts)
    .where(
      or(
        eq(updateInstallAttempts.status, "launch_failed"),
        and(
          eq(updateInstallAttempts.status, "launch_pending"),
          lt(updateInstallAttempts.startedAt, Date.now() - LAUNCH_PENDING_ROLLBACK_MS),
        ),
      ),
    )
    .limit(1000);
  const releasesPublished = rows.length;
  // Heuristic: down if we have nothing published; degraded if signing is
  // off or there's a backlog of pending rollbacks > 10; otherwise ok.
  let status: ServerHealthSnapshot["status"] = "ok";
  if (releasesPublished === 0) status = "down";
  else if (!signingConfigured() || pendingRollbacks.length > 10) status = "degraded";
  return {
    status,
    releasesPublished,
    channelsActive: channels,
    latestPublishedAt,
    signingConfigured: signingConfigured(),
    verificationConfigured: verificationConfigured(),
    rollbackPendingCount: pendingRollbacks.length,
    checkedAt: new Date().toISOString(),
  };
}

// Re-export helpers used by tests.
export const __test = {
  rolloutBucket,
  isInRollout,
  compareVersions,
  canonicalSigningPayload,
};
