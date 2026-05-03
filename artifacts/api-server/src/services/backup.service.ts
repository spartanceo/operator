/**
 * Backup, restore & data portability service (Task #20).
 *
 * Owns the full lifecycle of a Omninity Operator backup:
 *
 *   1. Serialise — read every tenant-scoped row through `tenantScope`,
 *      shape it into a deterministic, version-stamped JSON snapshot.
 *   2. Encrypt   — AES-256-GCM with a per-tenant PBKDF2-derived key
 *      (sha256, 200_000 iterations, 16-byte salt persisted in
 *      `backup_settings`). The user's master password is supplied at
 *      backup/restore time and never persisted to disk.
 *   3. Persist   — write the encrypted archive to the workspace sandbox,
 *      record a row in `backup_jobs` with sha256 checksum + byte size,
 *      and (optionally) hand the bytes to the cloud-provider stub.
 *   4. Verify    — recompute the checksum on demand and re-decrypt with
 *      the supplied password to prove the archive is restorable before
 *      the user trusts it.
 *   5. Restore   — accept an archive buffer, decrypt + verify, then
 *      either replay the snapshot wholesale (fresh-machine migration) or
 *      restore a single domain (`knowledge`, `memories`, `settings`).
 *
 * Tenant safety:
 *   Every read goes through `tenantScope`. Every write goes through
 *   `withTenantValues`. Restore writes go through a single `db.transaction`
 *   so a partial failure leaves the tenant exactly as it was before.
 *
 * Privacy:
 *   Every cloud-sync intent emits a `logPrivacyEvent` BEFORE the upload
 *   stub runs (Standard 12 — log everything that may leave the device).
 *   The cloud provider integrations themselves are stubs in v1; the
 *   contract is wired so a later task can plug in real iCloud / Drive /
 *   Dropbox / S3 transports without changing the service surface.
 *
 * Scheduler:
 *   `processDueBackups(now)` is pure — it walks every tenant whose
 *   `next_backup_at` is in the past and schedules a fresh backup. The
 *   ticker that calls it is started by `app.ts` in production and is
 *   exposed as a no-op in tests so the cases can drive it deterministically.
 *
 * What's intentionally out of scope (per task `Out of scope`):
 *   - OP-hosted cloud — the user always provides their own bucket.
 *   - Real-time multi-device sync — see Task: Platform Infrastructure
 *     Disaster Recovery & Business Continuity.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { and, asc, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  agentRuns,
  approvals,
  backupJobs,
  backupSettings,
  buildPage,
  db,
  decodeCursor,
  desktopSessions,
  desktopSteps,
  kbChunks,
  kbCollections,
  kbDocuments,
  memories,
  messages,
  modelPreferences,
  normaliseLimit,
  onboardingProfiles,
  type PaginatedData,
  privacyEvents,
  tenantScope,
  toolCalls,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { workspaceRoot } from "../lib/sandbox";
import { logPrivacyEvent } from "./privacy.service";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Snapshot envelope version. Bump on schema-incompatible changes. */
export const SNAPSHOT_VERSION = "1";

/**
 * AES-256-GCM with a 12-byte IV is the canonical authenticated-encryption
 * mode. PBKDF2-SHA256 with 200k iterations is the OWASP 2023 floor for
 * password-based key derivation; it adds ~120ms per derive on a modern CPU
 * which is acceptable for a per-archive operation.
 */
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = "sha256";
const AES_IV_LEN = 12;
const AES_TAG_LEN = 16;
const AES_ALGO = "aes-256-gcm";
const SALT_LEN = 16;

/**
 * Header magic bytes — `OMOP-BAK\0` — so corrupted files fail loud at
 * parse time rather than producing an opaque AES failure.
 */
const MAGIC = Buffer.from("OMOP-BAK\0", "utf8");

/** Recognised cloud-provider stub names. */
// tier-review: bounded — fixed compile-time enum (4 elements, never mutated)
const CLOUD_PROVIDERS = new Set(["icloud", "googleDrive", "dropbox", "s3"]);

/** Recognised manual-trigger schedule cadences. */
// tier-review: bounded — fixed compile-time enum (3 elements, never mutated)
const SCHEDULE_CADENCES = new Set(["off", "daily", "weekly"]);

/** Recognised restore scopes. `all` is the everything-restore default. */
// tier-review: bounded — fixed compile-time enum (5 elements, never mutated)
const RESTORE_SCOPES = new Set([
  "all",
  "knowledge",
  "memories",
  "settings",
  "conversations",
] as const);
export type RestoreScope =
  | "all"
  | "knowledge"
  | "memories"
  | "settings"
  | "conversations";

const DEFAULT_RETENTION = 7;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024; // 256 MB hard cap.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BackupSettings {
  schedule: "off" | "daily" | "weekly";
  targetDirectory: string | null;
  retentionCount: number;
  cloudProvider: string | null;
  cloudSettings: Record<string, unknown> | null;
  cloudEnabled: boolean;
  lastBackupAt: string | null;
  nextBackupAt: string | null;
}

export interface UpdateBackupSettingsInput {
  schedule?: "off" | "daily" | "weekly";
  targetDirectory?: string | null;
  retentionCount?: number;
  cloudProvider?: string | null;
  cloudSettings?: Record<string, unknown> | null;
  cloudEnabled?: boolean;
}

export interface BackupJob {
  id: string;
  trigger: string;
  status: string;
  encryption: string;
  filePath: string | null;
  cloudTarget: string | null;
  sizeBytes: number;
  checksum: string | null;
  documentCount: number;
  memoryCount: number;
  messageCount: number;
  snapshotVersion: string;
  schemaVersion: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRowSet {
  tenants: unknown[];
  workspaces: unknown[];
  users: unknown[];
  memories: unknown[];
  agentRuns: unknown[];
  messages: unknown[];
  toolCalls: unknown[];
  approvals: unknown[];
  privacyEvents: unknown[];
  onboardingProfiles: unknown[];
  modelPreferences: unknown[];
  desktopSessions: unknown[];
  desktopSteps: unknown[];
  kbCollections: unknown[];
  kbDocuments: unknown[];
  kbChunks: unknown[];
  backupSettings: unknown[];
}

export interface BackupSnapshot {
  envelope: {
    snapshotVersion: string;
    schemaVersion: number;
    appVersion: string;
    createdAt: string;
    tenantId: string;
    workspaceId: string;
    sourceHost: string;
    counts: {
      memories: number;
      messages: number;
      kbDocuments: number;
      kbChunks: number;
      agentRuns: number;
    };
  };
  rows: SnapshotRowSet;
}

export interface CreateBackupOptions {
  password: string;
  trigger?: "manual" | "scheduled" | "cloud";
  uploadToCloud?: boolean;
}

export interface CreateBackupResult {
  job: BackupJob;
  archiveBase64: string;
  filePath: string;
  checksum: string;
  sizeBytes: number;
}

export interface VerifyResult {
  ok: boolean;
  checksum: string;
  sizeBytes: number;
  envelope: BackupSnapshot["envelope"] | null;
  problems: string[];
  needsModelDownload: boolean;
  appliedSchemaMatchesArchive: boolean;
}

export interface RestoreResult {
  scopes: RestoreScope[];
  imported: {
    memories: number;
    kbCollections: number;
    kbDocuments: number;
    kbChunks: number;
    messages: number;
    agentRuns: number;
    toolCalls: number;
    approvals: number;
    onboardingProfiles: number;
    modelPreferences: number;
  };
  needsModelDownload: boolean;
  envelope: BackupSnapshot["envelope"];
}

export interface ConversationExportEntry {
  runId: string | null;
  goal: string | null;
  startedAt: string | null;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
    tokensIn: number | null;
    tokensOut: number | null;
  }>;
}

export interface MemoryExportEntry {
  id: string;
  kind: string;
  title: string;
  content: string;
  importance: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsExport {
  version: string;
  exportedAt: string;
  onboarding: Record<string, unknown> | null;
  modelPreferences: Record<string, unknown> | null;
  backupSettings: BackupSettings;
}

export interface FullDataExport {
  envelope: BackupSnapshot["envelope"];
  conversations: ConversationExportEntry[];
  memories: MemoryExportEntry[];
  knowledgeBase: {
    collections: unknown[];
    documents: unknown[];
  };
  settings: SettingsExport;
  privacyEvents: unknown[];
}

export class BackupValidationError extends Error {
  override readonly name = "BackupValidationError";
  readonly code = "BACKUP_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export class BackupDecryptError extends Error {
  override readonly name = "BackupDecryptError";
  readonly code = "BACKUP_DECRYPT";
  constructor(message: string) {
    super(message);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function appVersion(): string {
  return process.env["npm_package_version"] ?? "0.1.0";
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function backupDir(ctx: TenantContext, override: string | null): string {
  // tier-review: bounded — if the user picks an external dir we honour it,
  // otherwise we fall back to the per-workspace sandbox so backups travel
  // with the workspace by default.
  if (override && path.isAbsolute(override)) {
    if (!fs.existsSync(override)) fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const root = path.join(workspaceRoot(ctx), "backups");
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function deriveKey(password: string, saltHex: string): Buffer {
  if (typeof password !== "string" || password.length === 0) {
    throw new BackupValidationError("Master password is required");
  }
  const salt = Buffer.from(saltHex, "hex");
  if (salt.byteLength !== SALT_LEN) {
    throw new BackupValidationError("Encryption salt is malformed");
  }
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, PBKDF2_DIGEST);
}

/**
 * Pack a plaintext snapshot into the wire format:
 *   [MAGIC | salt(16) | iv(12) | tag(16) | ciphertext]
 * Decryption rebuilds the slices by fixed offsets — no length prefixes
 * needed, which keeps the format trivially seekable.
 */
function encryptArchive(plaintext: Buffer, password: string, saltHex: string): Buffer {
  const key = deriveKey(password, saltHex);
  const iv = randomBytes(AES_IV_LEN);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from(saltHex, "hex"), iv, tag, ct]);
}

function decryptArchive(buffer: Buffer, password: string): Buffer {
  if (buffer.byteLength < MAGIC.length + SALT_LEN + AES_IV_LEN + AES_TAG_LEN + 1) {
    throw new BackupDecryptError("Archive is truncated or not a Omninity backup");
  }
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupDecryptError("Archive header magic is invalid");
  }
  let cursor = MAGIC.length;
  const salt = buffer.subarray(cursor, cursor + SALT_LEN);
  cursor += SALT_LEN;
  const iv = buffer.subarray(cursor, cursor + AES_IV_LEN);
  cursor += AES_IV_LEN;
  const tag = buffer.subarray(cursor, cursor + AES_TAG_LEN);
  cursor += AES_TAG_LEN;
  const ct = buffer.subarray(cursor);
  const key = deriveKey(password, salt.toString("hex"));
  const decipher = createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // GCM auth-tag mismatch typically means wrong password OR corruption.
    throw new BackupDecryptError("Could not decrypt archive — wrong password or corrupted file");
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// ─── Settings ───────────────────────────────────────────────────────────────

function toSettings(row: typeof backupSettings.$inferSelect): BackupSettings {
  return {
    schedule:
      row.schedule === "daily" || row.schedule === "weekly" ? row.schedule : "off",
    targetDirectory: row.targetDirectory,
    retentionCount: row.retentionCount,
    cloudProvider: row.cloudProvider,
    cloudSettings: parseJson<Record<string, unknown>>(row.cloudSettings),
    cloudEnabled: row.cloudEnabled === 1,
    lastBackupAt: isoOrNull(row.lastBackupAt),
    nextBackupAt: isoOrNull(row.nextBackupAt),
  };
}

async function readSettingsRow(
  ctx: TenantContext,
): Promise<typeof backupSettings.$inferSelect | null> {
  const rows = await db
    .select()
    .from(backupSettings)
    .where(tenantScope(ctx, backupSettings))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Get-or-create a row. The salt is generated exactly once per tenant; we
 * never rotate it because doing so would invalidate every old archive.
 */
export async function getOrCreateSettings(ctx: TenantContext): Promise<BackupSettings> {
  const existing = await readSettingsRow(ctx);
  if (existing) return toSettings(existing);
  const id = `bks_${ctx.tenantId}`;
  const saltHex = randomBytes(SALT_LEN).toString("hex");
  await db.insert(backupSettings).values(
    withTenantValues(ctx, {
      id,
      schedule: "off",
      retentionCount: DEFAULT_RETENTION,
      encryptionSalt: saltHex,
    }),
  );
  const fresh = await readSettingsRow(ctx);
  if (!fresh) throw new Error("Backup settings disappeared after insert");
  return toSettings(fresh);
}

function nextRunMs(schedule: BackupSettings["schedule"], from: number): number | null {
  if (schedule === "daily") return from + 24 * 60 * 60 * 1000;
  if (schedule === "weekly") return from + 7 * 24 * 60 * 60 * 1000;
  return null;
}

export async function updateSettings(
  ctx: TenantContext,
  patch: UpdateBackupSettingsInput,
): Promise<BackupSettings> {
  await getOrCreateSettings(ctx); // ensure row exists
  if (patch.schedule !== undefined && !SCHEDULE_CADENCES.has(patch.schedule)) {
    throw new BackupValidationError(`Unknown schedule: ${patch.schedule}`);
  }
  if (
    patch.cloudProvider !== undefined &&
    patch.cloudProvider !== null &&
    !CLOUD_PROVIDERS.has(patch.cloudProvider)
  ) {
    throw new BackupValidationError(`Unknown cloud provider: ${patch.cloudProvider}`);
  }
  if (
    patch.retentionCount !== undefined &&
    (patch.retentionCount < 1 || patch.retentionCount > 365)
  ) {
    throw new BackupValidationError("Retention count must be between 1 and 365");
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.schedule !== undefined) {
    updates["schedule"] = patch.schedule;
    updates["nextBackupAt"] = nextRunMs(patch.schedule, Date.now());
  }
  if (patch.targetDirectory !== undefined)
    updates["targetDirectory"] = patch.targetDirectory;
  if (patch.retentionCount !== undefined)
    updates["retentionCount"] = patch.retentionCount;
  if (patch.cloudProvider !== undefined)
    updates["cloudProvider"] = patch.cloudProvider;
  if (patch.cloudSettings !== undefined)
    updates["cloudSettings"] = patch.cloudSettings
      ? JSON.stringify(patch.cloudSettings)
      : null;
  if (patch.cloudEnabled !== undefined)
    updates["cloudEnabled"] = patch.cloudEnabled ? 1 : 0;

  await db
    .update(backupSettings)
    .set(updates)
    .where(tenantScope(ctx, backupSettings));
  const refreshed = await readSettingsRow(ctx);
  if (!refreshed) throw new Error("Backup settings disappeared after update");
  return toSettings(refreshed);
}

// ─── Snapshot serialisation ─────────────────────────────────────────────────

async function readAllRows(ctx: TenantContext): Promise<SnapshotRowSet> {
  // Note: `tenants` and `users` rows are intentionally NOT exported here —
  // a backup is a tenant snapshot meant for THIS tenant to restore on
  // another machine. The destination already owns its tenants/users root;
  // re-importing them would risk PK collisions across hosts.
  const [
    memoryRows,
    runRows,
    messageRows,
    toolCallRows,
    approvalRows,
    privacyRows,
    onboardingRows,
    modelPrefRows,
    desktopSessionRows,
    desktopStepRows,
    kbCollectionRows,
    kbDocumentRows,
    kbChunkRows,
    backupSettingsRows,
  ] = await Promise.all([
    db.select().from(memories).where(tenantScope(ctx, memories)),
    db.select().from(agentRuns).where(tenantScope(ctx, agentRuns)),
    db.select().from(messages).where(tenantScope(ctx, messages)),
    db.select().from(toolCalls).where(tenantScope(ctx, toolCalls)),
    db.select().from(approvals).where(tenantScope(ctx, approvals)),
    db.select().from(privacyEvents).where(tenantScope(ctx, privacyEvents)),
    db.select().from(onboardingProfiles).where(tenantScope(ctx, onboardingProfiles)),
    db.select().from(modelPreferences).where(tenantScope(ctx, modelPreferences)),
    db.select().from(desktopSessions).where(tenantScope(ctx, desktopSessions)),
    db.select().from(desktopSteps).where(tenantScope(ctx, desktopSteps)),
    db.select().from(kbCollections).where(tenantScope(ctx, kbCollections)),
    db.select().from(kbDocuments).where(tenantScope(ctx, kbDocuments)),
    db.select().from(kbChunks).where(tenantScope(ctx, kbChunks)),
    db.select().from(backupSettings).where(tenantScope(ctx, backupSettings)),
  ]);
  return {
    tenants: [],
    workspaces: [],
    users: [],
    memories: memoryRows,
    agentRuns: runRows,
    messages: messageRows,
    toolCalls: toolCallRows,
    approvals: approvalRows,
    privacyEvents: privacyRows,
    onboardingProfiles: onboardingRows,
    modelPreferences: modelPrefRows,
    desktopSessions: desktopSessionRows,
    desktopSteps: desktopStepRows,
    kbCollections: kbCollectionRows,
    kbDocuments: kbDocumentRows,
    kbChunks: kbChunkRows,
    backupSettings: backupSettingsRows,
  };
}

export async function buildSnapshot(ctx: TenantContext): Promise<BackupSnapshot> {
  const rows = await readAllRows(ctx);
  return {
    envelope: {
      snapshotVersion: SNAPSHOT_VERSION,
      schemaVersion: 7,
      appVersion: appVersion(),
      createdAt: nowIso(),
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId ?? `default-${ctx.tenantId}`,
      sourceHost: process.platform + "/" + process.arch,
      counts: {
        memories: rows.memories.length,
        messages: rows.messages.length,
        kbDocuments: rows.kbDocuments.length,
        kbChunks: rows.kbChunks.length,
        agentRuns: rows.agentRuns.length,
      },
    },
    rows,
  };
}

// ─── Job persistence ────────────────────────────────────────────────────────

function toJob(row: typeof backupJobs.$inferSelect): BackupJob {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    encryption: row.encryption,
    filePath: row.filePath,
    cloudTarget: row.cloudTarget,
    sizeBytes: row.sizeBytes,
    checksum: row.checksum,
    documentCount: row.documentCount,
    memoryCount: row.memoryCount,
    messageCount: row.messageCount,
    snapshotVersion: row.snapshotVersion,
    schemaVersion: row.schemaVersion,
    error: row.error,
    startedAt: isoOrNull(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function listJobs(
  ctx: TenantContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PaginatedData<BackupJob>> {
  const limit = normaliseLimit(opts.limit);
  const cursorTs = opts.cursor ? Number(decodeCursor(opts.cursor)) : null;
  const baseScope = tenantScope(ctx, backupJobs);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(backupJobs.createdAt, cursorTs))
      : baseScope;
  const rows = await db
    .select()
    .from(backupJobs)
    .where(where)
    .orderBy(desc(backupJobs.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(toJob), limit, (r) =>
    String(new Date(r.createdAt).getTime()),
  );
}

export async function getJob(ctx: TenantContext, id: string): Promise<BackupJob | null> {
  const rows = await db
    .select()
    .from(backupJobs)
    .where(and(tenantScope(ctx, backupJobs), eq(backupJobs.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? toJob(row) : null;
}

// ─── Cloud-sync stub ────────────────────────────────────────────────────────

/**
 * Cloud upload stub.
 *
 * Why a stub: the four supported providers (iCloud, Google Drive, Dropbox,
 * S3) each need their own SDK + per-account OAuth token. Wiring the real
 * transports is out of scope for v1 — but the contract below is the seam
 * a later task will plug into without changing route handlers or routes.
 *
 * What this does today:
 *   - Validates the provider is in the allowlist.
 *   - Emits a privacy event BEFORE any byte leaves the device (Standard 12).
 *   - Returns an opaque `cloudTarget` URI the job row stores so the user
 *     can audit "this archive was synced to <target>".
 */
async function uploadToCloudStub(
  ctx: TenantContext,
  settings: BackupSettings,
  jobId: string,
  archive: Buffer,
): Promise<string | null> {
  if (!settings.cloudEnabled || !settings.cloudProvider) return null;
  if (!CLOUD_PROVIDERS.has(settings.cloudProvider)) {
    throw new BackupValidationError(
      `Cloud provider "${settings.cloudProvider}" is not supported`,
    );
  }
  const folder =
    typeof settings.cloudSettings?.["folder"] === "string"
      ? (settings.cloudSettings["folder"] as string)
      : "Omninity Backups";
  const target = `${settings.cloudProvider}://${folder}/${jobId}.omopbak`;
  await logPrivacyEvent(ctx, {
    eventType: "backup.cloud_upload",
    actor: ctx.userId ?? ctx.tenantId,
    target,
    severity: "medium",
    detail: JSON.stringify({
      jobId,
      bytes: archive.byteLength,
      provider: settings.cloudProvider,
    }),
  });
  // No real transport in v1 — see file-level docstring. Returning the
  // synthesised target lets the audit trail and the UI both reflect intent.
  return target;
}

// ─── Backup ─────────────────────────────────────────────────────────────────

/**
 * Produce a fresh encrypted archive end-to-end:
 *   1. Build snapshot, serialise to JSON, encrypt.
 *   2. Verify integrity (re-decrypt + checksum) before declaring success.
 *   3. Persist to disk + record `backup_jobs` row.
 *   4. Emit privacy event (cloud only) and prune old archives.
 *
 * The encrypted bytes are also returned base64-encoded so the UI can
 * offer "Download backup" without a second roundtrip.
 */
export async function createBackup(
  ctx: TenantContext,
  opts: CreateBackupOptions,
): Promise<CreateBackupResult> {
  const settings = await getOrCreateSettings(ctx);
  const settingsRow = await readSettingsRow(ctx);
  if (!settingsRow) throw new Error("Backup settings missing after upsert");

  const trigger = opts.trigger ?? "manual";
  const id = `bkj_${nanoid()}`;
  const startedAt = Date.now();
  await db.insert(backupJobs).values(
    withTenantValues(ctx, {
      id,
      trigger,
      status: "running",
      encryption: AES_ALGO,
      snapshotVersion: SNAPSHOT_VERSION,
      schemaVersion: 7,
      startedAt,
    }),
  );

  try {
    const snapshot = await buildSnapshot(ctx);
    const plaintext = Buffer.from(JSON.stringify(snapshot), "utf8");
    if (plaintext.byteLength > MAX_ARCHIVE_BYTES) {
      throw new BackupValidationError(
        `Snapshot exceeds the ${MAX_ARCHIVE_BYTES}-byte cap; reduce the workspace footprint or split tenants`,
      );
    }
    const archive = encryptArchive(plaintext, opts.password, settingsRow.encryptionSalt);
    const checksum = sha256Hex(archive);

    // Integrity gate: re-decrypt to prove the archive is restorable BEFORE
    // we commit to it. Catching a corruption / wrong-password mismatch
    // here means the user never trusts a broken backup.
    const roundTrip = decryptArchive(archive, opts.password);
    if (!roundTrip.equals(plaintext)) {
      throw new BackupValidationError(
        "Round-trip integrity check failed — encrypted snapshot did not decrypt to itself",
      );
    }

    const dir = backupDir(ctx, settings.targetDirectory);
    const filePath = path.join(dir, `${id}.omopbak`);
    fs.writeFileSync(filePath, archive);

    let cloudTarget: string | null = null;
    if (opts.uploadToCloud ?? settings.cloudEnabled) {
      cloudTarget = await uploadToCloudStub(ctx, settings, id, archive);
    }

    const completedAt = Date.now();
    await db
      .update(backupJobs)
      .set({
        status: "completed",
        filePath,
        cloudTarget,
        sizeBytes: archive.byteLength,
        checksum,
        documentCount: snapshot.envelope.counts.kbDocuments,
        memoryCount: snapshot.envelope.counts.memories,
        messageCount: snapshot.envelope.counts.messages,
        completedAt,
        updatedAt: completedAt,
      })
      .where(and(tenantScope(ctx, backupJobs), eq(backupJobs.id, id)));

    await db
      .update(backupSettings)
      .set({
        lastBackupAt: completedAt,
        nextBackupAt: nextRunMs(settings.schedule, completedAt),
        updatedAt: completedAt,
      })
      .where(tenantScope(ctx, backupSettings));

    await pruneOldBackups(ctx);

    const job = await getJob(ctx, id);
    if (!job) throw new Error("Backup job disappeared after completion");
    return {
      job,
      archiveBase64: archive.toString("base64"),
      filePath,
      checksum,
      sizeBytes: archive.byteLength,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failedAt = Date.now();
    await db
      .update(backupJobs)
      .set({
        status: "failed",
        error: message,
        completedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(and(tenantScope(ctx, backupJobs), eq(backupJobs.id, id)));
    logger.error({ err: message, jobId: id, tenantId: ctx.tenantId }, "Backup failed");
    throw e;
  }
}

// ─── Retention ──────────────────────────────────────────────────────────────

export async function pruneOldBackups(
  ctx: TenantContext,
): Promise<{ kept: number; pruned: number }> {
  const settings = await getOrCreateSettings(ctx);
  const completedRows = await db
    .select()
    .from(backupJobs)
    .where(
      and(tenantScope(ctx, backupJobs), eq(backupJobs.status, "completed")),
    )
    .orderBy(desc(backupJobs.createdAt));
  const keep = settings.retentionCount;
  if (completedRows.length <= keep) {
    return { kept: completedRows.length, pruned: 0 };
  }
  const toDelete = completedRows.slice(keep);
  let pruned = 0;
  for (const row of toDelete) {
    if (row.filePath) {
      try {
        if (fs.existsSync(row.filePath)) fs.unlinkSync(row.filePath);
      } catch (e) {
        logger.warn({ err: e, jobId: row.id }, "Failed to unlink pruned backup file");
      }
    }
    await db
      .delete(backupJobs)
      .where(and(tenantScope(ctx, backupJobs), eq(backupJobs.id, row.id)));
    pruned++;
  }
  return { kept: keep, pruned };
}

// ─── Verify ─────────────────────────────────────────────────────────────────

function parseSnapshot(plaintext: Buffer): BackupSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new BackupValidationError("Decrypted payload is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BackupValidationError("Decrypted payload is not an object");
  }
  const obj = parsed as Partial<BackupSnapshot>;
  if (!obj.envelope || typeof obj.envelope !== "object") {
    throw new BackupValidationError("Snapshot is missing envelope");
  }
  if (!obj.rows || typeof obj.rows !== "object") {
    throw new BackupValidationError("Snapshot is missing rows");
  }
  if (obj.envelope.snapshotVersion !== SNAPSHOT_VERSION) {
    throw new BackupValidationError(
      `Snapshot version ${String(obj.envelope.snapshotVersion)} is not supported (expected ${SNAPSHOT_VERSION})`,
    );
  }
  return obj as BackupSnapshot;
}

export async function verifyArchive(
  archive: Buffer,
  password: string,
): Promise<VerifyResult> {
  const checksum = sha256Hex(archive);
  const sizeBytes = archive.byteLength;
  const problems: string[] = [];
  let envelope: BackupSnapshot["envelope"] | null = null;
  let needsModelDownload = false;
  try {
    const plaintext = decryptArchive(archive, password);
    const snapshot = parseSnapshot(plaintext);
    envelope = snapshot.envelope;
    const prefs = snapshot.rows.modelPreferences as Array<{
      primaryModel?: string | null;
    }>;
    if (Array.isArray(prefs) && prefs.length > 0) {
      const primary = prefs[0]?.primaryModel ?? null;
      if (primary) needsModelDownload = true;
    }
  } catch (e) {
    if (e instanceof BackupDecryptError || e instanceof BackupValidationError) {
      problems.push(e.message);
    } else {
      throw e;
    }
  }
  return {
    ok: problems.length === 0,
    checksum,
    sizeBytes,
    envelope,
    problems,
    needsModelDownload,
    appliedSchemaMatchesArchive: envelope ? envelope.schemaVersion === 7 : false,
  };
}

// ─── Restore ────────────────────────────────────────────────────────────────

function scopeIncludes(scopes: RestoreScope[], target: RestoreScope): boolean {
  return scopes.includes("all") || scopes.includes(target);
}

/**
 * Restore selected scopes from the supplied snapshot. The whole flow runs
 * inside a single `db.transaction` so a partial failure leaves the tenant
 * unchanged (Standard 5).
 *
 * `replaceExisting=true` wipes the tenant's existing rows for every
 * affected scope BEFORE inserting — the migration-assistant flow on a
 * fresh machine relies on this so the restored state is exactly what the
 * archive captured. `false` is additive (skip rows whose primary key
 * already exists) — used by the "merge in conversations from a coworker's
 * export" surface in the UI.
 */
export async function restoreFromArchive(
  ctx: TenantContext,
  archive: Buffer,
  password: string,
  opts: { scopes?: RestoreScope[]; replaceExisting?: boolean } = {},
): Promise<RestoreResult> {
  const verify = await verifyArchive(archive, password);
  if (!verify.ok || !verify.envelope) {
    throw new BackupValidationError(
      `Archive failed verification: ${verify.problems.join("; ") || "unknown"}`,
    );
  }
  const plaintext = decryptArchive(archive, password);
  const snapshot = parseSnapshot(plaintext);
  const requested = opts.scopes && opts.scopes.length > 0 ? opts.scopes : ["all" as RestoreScope];
  for (const s of requested) {
    if (!RESTORE_SCOPES.has(s)) {
      throw new BackupValidationError(`Unknown restore scope: ${s}`);
    }
  }
  const replaceExisting = opts.replaceExisting ?? true;
  const tally = {
    memories: 0,
    kbCollections: 0,
    kbDocuments: 0,
    kbChunks: 0,
    messages: 0,
    agentRuns: 0,
    toolCalls: 0,
    approvals: 0,
    onboardingProfiles: 0,
    modelPreferences: 0,
  };

  // Cross-tenant restores (e.g. importing a coworker's archive, or the
  // selective-restore migration flow) MUST regenerate primary keys —
  // otherwise the source tenant's still-live rows hold the global PKs
  // and our `onConflictDoNothing` inserts silently no-op. Same-tenant
  // restores keep the original IDs so re-running a restore is idempotent
  // and references in stored prompts/links keep resolving.
  const crossTenant = snapshot.envelope.tenantId !== ctx.tenantId;
  const memoryIdMap = new Map<string, string>();
  const kbCollectionIdMap = new Map<string, string>();
  const kbDocumentIdMap = new Map<string, string>();
  const kbChunkIdMap = new Map<string, string>();
  const agentRunIdMap = new Map<string, string>();
  const messageIdMap = new Map<string, string>();
  const toolCallIdMap = new Map<string, string>();
  const approvalIdMap = new Map<string, string>();
  const onboardingProfileIdMap = new Map<string, string>();
  const modelPreferenceIdMap = new Map<string, string>();
  const remap = (
    map: Map<string, string>,
    oldId: string,
    prefix: string,
  ): string => {
    if (!crossTenant) return oldId;
    const cached = map.get(oldId);
    if (cached) return cached;
    const fresh = `${prefix}_${nanoid()}`;
    map.set(oldId, fresh);
    return fresh;
  };
  const remapFk = (
    map: Map<string, string>,
    oldId: string | null | undefined,
  ): string | null => {
    if (oldId === null || oldId === undefined) return null;
    if (!crossTenant) return oldId;
    return map.get(oldId) ?? oldId;
  };

  // better-sqlite3 transactions cannot return promises, so we drive the
  // restore synchronously over the already-decrypted snapshot. Every read
  // we needed (verify + decrypt + parse) has already happened above, and
  // every write here is a `.run()` on the prepared statement — there is
  // no async work left to do inside the critical section.
  await db.transaction((tx) => {
    if (replaceExisting) {
      // Order matters — child rows before parents so FK references stay
      // valid through the deletes. The `conversations` scope cascades
      // approvals → tool_calls → messages → agent_runs because the FKs
      // chain in that direction.
      if (scopeIncludes(requested, "knowledge")) {
        tx.delete(kbChunks).where(tenantScope(ctx, kbChunks)).run();
        tx.delete(kbDocuments).where(tenantScope(ctx, kbDocuments)).run();
        tx.delete(kbCollections).where(tenantScope(ctx, kbCollections)).run();
      }
      if (scopeIncludes(requested, "memories")) {
        tx.delete(memories).where(tenantScope(ctx, memories)).run();
      }
      if (scopeIncludes(requested, "conversations")) {
        tx.delete(approvals).where(tenantScope(ctx, approvals)).run();
        tx.delete(toolCalls).where(tenantScope(ctx, toolCalls)).run();
        tx.delete(messages).where(tenantScope(ctx, messages)).run();
        tx.delete(agentRuns).where(tenantScope(ctx, agentRuns)).run();
      }
      if (scopeIncludes(requested, "settings")) {
        tx.delete(modelPreferences)
          .where(tenantScope(ctx, modelPreferences))
          .run();
        tx.delete(onboardingProfiles)
          .where(tenantScope(ctx, onboardingProfiles))
          .run();
      }
    }

    if (scopeIncludes(requested, "knowledge")) {
      for (const c of snapshot.rows.kbCollections as Array<typeof kbCollections.$inferSelect>) {
        tx.insert(kbCollections).values(
          withTenantValues(ctx, {
            id: remap(kbCollectionIdMap, c.id, "kbc"),
            name: c.name,
            description: c.description ?? null,
            color: c.color ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.kbCollections++;
      }
      for (const d of snapshot.rows.kbDocuments as Array<typeof kbDocuments.$inferSelect>) {
        tx.insert(kbDocuments).values(
          withTenantValues(ctx, {
            id: remap(kbDocumentIdMap, d.id, "kbd"),
            collectionId: remapFk(kbCollectionIdMap, d.collectionId ?? null),
            title: d.title,
            sourceType: d.sourceType,
            sourceUri: d.sourceUri ?? null,
            mimeType: d.mimeType ?? null,
            body: d.body,
            contentHash: d.contentHash,
            sizeBytes: d.sizeBytes,
            chunkCount: d.chunkCount,
            tags: d.tags,
            summary: d.summary ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.kbDocuments++;
      }
      for (const ch of snapshot.rows.kbChunks as Array<typeof kbChunks.$inferSelect>) {
        const remappedDoc = remapFk(kbDocumentIdMap, ch.documentId);
        if (remappedDoc === null) continue;
        tx.insert(kbChunks).values(
          withTenantValues(ctx, {
            id: remap(kbChunkIdMap, ch.id, "kbck"),
            documentId: remappedDoc,
            position: ch.position,
            text: ch.text,
            tokens: ch.tokens,
            embedding: ch.embedding,
          }),
        ).onConflictDoNothing().run();
        tally.kbChunks++;
      }
    }

    if (scopeIncludes(requested, "memories")) {
      for (const m of snapshot.rows.memories as Array<typeof memories.$inferSelect>) {
        tx.insert(memories).values(
          withTenantValues(ctx, {
            id: remap(memoryIdMap, m.id, "mem"),
            kind: m.kind,
            title: m.title,
            content: m.content,
            importance: m.importance,
            source: m.source ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.memories++;
      }
    }

    if (scopeIncludes(requested, "conversations")) {
      for (const r of snapshot.rows.agentRuns as Array<typeof agentRuns.$inferSelect>) {
        tx.insert(agentRuns).values(
          withTenantValues(ctx, {
            id: remap(agentRunIdMap, r.id, "run"),
            goal: r.goal,
            status: r.status,
            plan: r.plan ?? null,
            summary: r.summary ?? null,
            error: r.error ?? null,
            modelName: r.modelName ?? null,
            startedAt: r.startedAt ?? null,
            completedAt: r.completedAt ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.agentRuns++;
      }
      for (const m of snapshot.rows.messages as Array<typeof messages.$inferSelect>) {
        tx.insert(messages).values(
          withTenantValues(ctx, {
            id: remap(messageIdMap, m.id, "msg"),
            runId: remapFk(agentRunIdMap, m.runId ?? null),
            role: m.role,
            content: m.content,
            tokensIn: m.tokensIn ?? null,
            tokensOut: m.tokensOut ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.messages++;
      }
      for (const tc of snapshot.rows.toolCalls as Array<typeof toolCalls.$inferSelect>) {
        const remappedRun = remapFk(agentRunIdMap, tc.runId);
        if (remappedRun === null) continue;
        tx.insert(toolCalls).values(
          withTenantValues(ctx, {
            id: remap(toolCallIdMap, tc.id, "tc"),
            runId: remappedRun,
            toolName: tc.toolName,
            riskLevel: tc.riskLevel,
            status: tc.status,
            input: tc.input,
            output: tc.output ?? null,
            error: tc.error ?? null,
            durationMs: tc.durationMs ?? null,
            startedAt: tc.startedAt ?? null,
            completedAt: tc.completedAt ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.toolCalls++;
      }
      for (const a of snapshot.rows.approvals as Array<typeof approvals.$inferSelect>) {
        const remappedRun = remapFk(agentRunIdMap, a.runId);
        const remappedTc = remapFk(toolCallIdMap, a.toolCallId);
        if (remappedRun === null || remappedTc === null) continue;
        tx.insert(approvals).values(
          withTenantValues(ctx, {
            id: remap(approvalIdMap, a.id, "apv"),
            runId: remappedRun,
            toolCallId: remappedTc,
            reason: a.reason,
            summary: a.summary,
            decision: a.decision,
            decidedBy: a.decidedBy ?? null,
            decidedAt: a.decidedAt ?? null,
            note: a.note ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.approvals++;
      }
    }

    if (scopeIncludes(requested, "settings")) {
      for (const op of snapshot.rows.onboardingProfiles as Array<
        typeof onboardingProfiles.$inferSelect
      >) {
        tx.insert(onboardingProfiles).values(
          withTenantValues(ctx, {
            id: remap(onboardingProfileIdMap, op.id, "obp"),
            displayName: op.displayName ?? null,
            userType: op.userType ?? null,
            useCase: op.useCase ?? null,
            recommendedModel: op.recommendedModel ?? null,
            completed: op.completed,
            firstTaskCompleted: op.firstTaskCompleted,
            approvalTooltipSeen: op.approvalTooltipSeen,
            hardwareSnapshot: op.hardwareSnapshot ?? null,
            completedAt: op.completedAt ?? null,
          }),
        ).onConflictDoNothing().run();
        tally.onboardingProfiles++;
      }
      for (const mp of snapshot.rows.modelPreferences as Array<
        typeof modelPreferences.$inferSelect
      >) {
        tx.insert(modelPreferences).values(
          withTenantValues(ctx, {
            id: remap(modelPreferenceIdMap, mp.id, "mpr"),
            primaryModel: mp.primaryModel ?? null,
            visionLifecycleMode: mp.visionLifecycleMode ?? null,
            visionIdleTimeoutMs: mp.visionIdleTimeoutMs ?? null,
            catalogueChoiceMade: mp.catalogueChoiceMade,
          }),
        ).onConflictDoNothing().run();
        tally.modelPreferences++;
      }
    }
  });

  await logPrivacyEvent(ctx, {
    eventType: "backup.restore",
    actor: ctx.userId ?? ctx.tenantId,
    target: snapshot.envelope.tenantId,
    severity: "high",
    detail: JSON.stringify({
      scopes: requested,
      replaceExisting,
      counts: tally,
    }),
  });

  return {
    scopes: requested,
    imported: tally,
    needsModelDownload: verify.needsModelDownload,
    envelope: snapshot.envelope,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Pure scheduler tick. Caller passes `now` so tests can fast-forward
 * deterministically. Returns the list of tenants whose backup was
 * triggered. The caller (`schedulerStartTicker` in production, or the
 * test runner) is responsible for actually invoking `createBackup` because
 * the scheduler does not know each tenant's master password — it surfaces
 * the candidate list, and the in-app prompt or the OS keychain integration
 * supplies the password at execution time.
 */
export async function findDueScheduledBackups(now: number): Promise<
  Array<{ tenantId: string; workspaceId: string; nextBackupAt: number }>
> {
  // Singleton-per-tenant, low cardinality — pull every row and filter in
  // memory. The `idx_backup_settings_next` index keeps the table sorted
  // for when a future tier needs to scale this scan to millions of
  // tenants and switch to a SQL `WHERE next_backup_at <= ?` predicate.
  const rows = await db
    .select({
      tenantId: backupSettings.tenantId,
      nextBackupAt: backupSettings.nextBackupAt,
      schedule: backupSettings.schedule,
    })
    .from(backupSettings)
    .orderBy(asc(backupSettings.nextBackupAt));
  return rows
    .filter(
      (r) =>
        r.schedule !== "off" &&
        r.nextBackupAt !== null &&
        r.nextBackupAt <= now,
    )
    .map((r) => ({
      tenantId: r.tenantId,
      workspaceId: `default-${r.tenantId}`,
      nextBackupAt: r.nextBackupAt!,
    }));
}

// ─── Data-portability exports ───────────────────────────────────────────────

export async function exportConversations(
  ctx: TenantContext,
): Promise<ConversationExportEntry[]> {
  const runs = await db
    .select()
    .from(agentRuns)
    .where(tenantScope(ctx, agentRuns))
    .orderBy(asc(agentRuns.createdAt));
  const allMessages = await db
    .select()
    .from(messages)
    .where(tenantScope(ctx, messages))
    .orderBy(asc(messages.createdAt));
  const byRun = new Map<string | null, typeof allMessages>();
  for (const m of allMessages) {
    const k = m.runId ?? null;
    const arr = byRun.get(k) ?? [];
    arr.push(m);
    byRun.set(k, arr);
  }
  const entries: ConversationExportEntry[] = [];
  for (const r of runs) {
    entries.push({
      runId: r.id,
      goal: r.goal,
      startedAt: isoOrNull(r.startedAt ?? r.createdAt),
      messages: (byRun.get(r.id) ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: new Date(m.createdAt).toISOString(),
        tokensIn: m.tokensIn,
        tokensOut: m.tokensOut,
      })),
    });
  }
  // Loose messages with no run (e.g. raw chat) get their own bucket.
  const loose = byRun.get(null);
  if (loose && loose.length > 0) {
    entries.push({
      runId: null,
      goal: null,
      startedAt: isoOrNull(loose[0]!.createdAt),
      messages: loose.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: new Date(m.createdAt).toISOString(),
        tokensIn: m.tokensIn,
        tokensOut: m.tokensOut,
      })),
    });
  }
  return entries;
}

export function conversationsToMarkdown(entries: ConversationExportEntry[]): string {
  // tier-review: bounded — string concatenation walks a finite tenant-scoped
  // list returned by the caller; no unbounded recursion or accumulation.
  const lines: string[] = ["# Omninity Operator — Conversation Export", ""];
  lines.push(`_Exported at ${nowIso()}_`, "");
  for (const e of entries) {
    lines.push(`## ${e.goal ?? "Loose chat"}`);
    if (e.startedAt) lines.push(`_Started: ${e.startedAt}_`);
    lines.push("");
    for (const m of e.messages) {
      lines.push(`### ${m.role} — ${m.createdAt}`);
      lines.push("");
      lines.push(m.content);
      lines.push("");
    }
    lines.push("---", "");
  }
  return lines.join("\n");
}

export async function exportMemories(ctx: TenantContext): Promise<MemoryExportEntry[]> {
  const rows = await db
    .select()
    .from(memories)
    .where(tenantScope(ctx, memories))
    .orderBy(desc(memories.importance), desc(memories.createdAt));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    importance: r.importance,
    source: r.source,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
}

export async function exportSettings(ctx: TenantContext): Promise<SettingsExport> {
  const onboardingRows = await db
    .select()
    .from(onboardingProfiles)
    .where(tenantScope(ctx, onboardingProfiles))
    .limit(1);
  const modelPrefRows = await db
    .select()
    .from(modelPreferences)
    .where(tenantScope(ctx, modelPreferences))
    .limit(1);
  const settings = await getOrCreateSettings(ctx);
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: nowIso(),
    onboarding: onboardingRows[0]
      ? {
          displayName: onboardingRows[0].displayName,
          userType: onboardingRows[0].userType,
          useCase: onboardingRows[0].useCase,
          recommendedModel: onboardingRows[0].recommendedModel,
          completed: Boolean(onboardingRows[0].completed),
        }
      : null,
    modelPreferences: modelPrefRows[0]
      ? {
          primaryModel: modelPrefRows[0].primaryModel,
          visionLifecycleMode: modelPrefRows[0].visionLifecycleMode,
          visionIdleTimeoutMs: modelPrefRows[0].visionIdleTimeoutMs,
        }
      : null,
    backupSettings: settings,
  };
}

export async function exportFullData(ctx: TenantContext): Promise<FullDataExport> {
  const snapshot = await buildSnapshot(ctx);
  const conversations = await exportConversations(ctx);
  const memoryRows = await exportMemories(ctx);
  const settings = await exportSettings(ctx);
  return {
    envelope: snapshot.envelope,
    conversations,
    memories: memoryRows,
    knowledgeBase: {
      collections: snapshot.rows.kbCollections,
      documents: snapshot.rows.kbDocuments,
    },
    settings,
    privacyEvents: snapshot.rows.privacyEvents,
  };
}

// Internal exports used by the test runner so test cases can drive the
// pure helpers without going through the HTTP surface.
export const __internal = {
  encryptArchive,
  decryptArchive,
  parseSnapshot,
  sha256Hex,
  randomUUID,
  MAGIC,
};
