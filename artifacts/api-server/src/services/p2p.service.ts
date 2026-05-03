/**
 * P2P Model & Skill Distribution service (Task #13).
 *
 * Omninity Operator distributes its 4–8 GB AI models and Skill
 * Marketplace payloads peer-to-peer (WebTorrent + IPFS) instead of
 * from central servers. The desktop shell does the actual byte-shuffling
 * — this service is the tracker / signing-verification surface it
 * talks to.
 *
 *   1. Signed content registry — publishers upload a `ContentManifest`
 *      (id, sha256, magnet uri, ipfs cid, size, signature). The server
 *      verifies the Ed25519 signature against a *pinned* publisher key
 *      registry before accepting it. Anything not signed by a pinned key
 *      is rejected — Sybil attackers cannot inject malicious payloads.
 *
 *   2. Swarm health — desktops periodically `announce` their peer counts
 *      and bytes-transferred per content id. The server aggregates this
 *      per tenant so the UI can render "X peers sharing this model" and
 *      so the fallback decision (`shouldFallbackToCdn`) has a number to
 *      compare against the configured peer-floor.
 *
 *   3. Privacy relays — a static list of relay nodes (seeded from
 *      `OMNINITY_P2P_RELAYS`) that the shell uses so peers cannot see
 *      each other's real IP addresses. Settings exposes a per-tenant
 *      "use relay" toggle which defaults on.
 *
 *   4. Seeding settings — per tenant: seedingEnabled, uploadCapMbps,
 *      useRelay, fallbackToCdn. Users on data-limited connections opt
 *      out of seeding (they still receive from peers).
 *
 *   5. Verification helper — after the shell finishes a download it
 *      reports the computed sha256; the server confirms it matches the
 *      signed manifest and emits an audit log line.
 *
 * Persistence: publisher keys, signed manifests, and seeding settings
 * live in SQLite (migration 0024) so a server restart does not erase
 * the catalogue or per-tenant preferences. Swarm telemetry (peer
 * counts, bytes transferred) stays in memory — it is ephemeral status
 * the desktop shell re-announces on its next heartbeat.
 */
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { getRawSqlite } from "@workspace/db";

import { logger } from "../lib/logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContentType = "model" | "skill";

export interface ContentManifest {
  contentId: string;
  contentType: ContentType;
  version: string;
  sizeBytes: number;
  sha256: string;
  magnetUri: string;
  ipfsCid: string;
  fallbackUrl: string | null;
  publisherKeyId: string;
  publishedAt: string;
}

export interface SignedManifest {
  manifest: ContentManifest;
  /** Base64-encoded Ed25519 signature over the canonical JSON of `manifest`. */
  signature: string;
}

export interface PublisherKey {
  keyId: string;
  label: string;
  /** PEM-encoded SPKI Ed25519 public key. */
  publicKeyPem: string;
  /** Pinned keys cannot be removed without a desktop client update. */
  pinned: boolean;
  registeredAt: string;
}

export type SwarmHealth = "healthy" | "low_peers" | "fallback_active";

export interface SwarmStats {
  contentId: string;
  peerCount: number;
  uploadBytes: number;
  downloadBytes: number;
  lastSeenAt: string;
  health: SwarmHealth;
}

export interface SeedingSettings {
  seedingEnabled: boolean;
  uploadCapMbps: number | null;
  useRelay: boolean;
  fallbackToCdn: boolean;
  /** Minimum peer count below which the shell should ask the CDN fallback. */
  peerFloor: number;
}

export interface RelayNode {
  id: string;
  region: string;
  url: string;
  protocol: "wss" | "tcp" | "udp";
}

export interface NetworkOverview {
  swarms: SwarmStats[];
  totals: {
    peerCount: number;
    uploadBytes: number;
    downloadBytes: number;
    activeSwarms: number;
  };
  settings: SeedingSettings;
  relays: RelayNode[];
}

export interface VerifyResult {
  contentId: string;
  ok: boolean;
  reason: string | null;
}

// ─── State ─────────────────────────────────────────────────────────────────
//
// Durable: publisher keys, signed manifests, seeding settings — all in
// SQLite (migration 0024). Ephemeral: per-tenant swarm telemetry —
// re-reported by the desktop shell every heartbeat, so a restart only
// loses one cycle of stats.

// tier-review: bounded — outer keyed by tenantId (bounded by licence + GDPR-erase), inner bounded by the number of content ids a tenant has interacted with.
const tenantSwarms = new Map<string, Map<string, SwarmStats>>();

// Test-only: holds the in-memory Ed25519 private key for the seeded
// "op-root" publisher so the test runner can produce signed manifests
// without shipping a real key. NEVER populated in production —
// production loads only *public* keys via OMNINITY_P2P_PINNED_KEYS.
let testRootPrivateKeyPem: string | null = null;

const DEFAULT_SETTINGS: SeedingSettings = {
  seedingEnabled: true,
  uploadCapMbps: null,
  useRelay: true,
  fallbackToCdn: true,
  peerFloor: 3,
};

function defaultRelays(): RelayNode[] {
  const raw = process.env["OMNINITY_P2P_RELAYS"];
  if (!raw) {
    return [
      { id: "relay-eu-1", region: "eu-west", url: "wss://relay-eu-1.omninity.app", protocol: "wss" },
      { id: "relay-us-1", region: "us-east", url: "wss://relay-us-1.omninity.app", protocol: "wss" },
      { id: "relay-ap-1", region: "ap-south", url: "wss://relay-ap-1.omninity.app", protocol: "wss" },
    ];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url, i) => ({
      id: `relay-${i + 1}`,
      region: "configured",
      url,
      protocol: "wss" as const,
    }));
}

function getOrCreateSwarmMap(tenantId: string): Map<string, SwarmStats> {
  let m = tenantSwarms.get(tenantId);
  if (!m) {
    m = new Map();
    tenantSwarms.set(tenantId, m);
  }
  return m;
}

// ─── Persistence helpers ───────────────────────────────────────────────────

interface PublisherKeyRow {
  key_id: string;
  label: string;
  public_key_pem: string;
  pinned: number;
  registered_at: number;
}

interface ManifestRow {
  content_id: string;
  content_type: string;
  version_label: string;
  size_bytes: number;
  sha256: string;
  magnet_uri: string;
  ipfs_cid: string;
  fallback_url: string | null;
  publisher_key_id: string;
  published_at: string;
  signature: string;
}

interface SettingsRow {
  tenant_id: string;
  seeding_enabled: number;
  upload_cap_mbps: number | null;
  use_relay: number;
  fallback_to_cdn: number;
  peer_floor: number;
}

function rowToKey(r: PublisherKeyRow): PublisherKey {
  return {
    keyId: r.key_id,
    label: r.label,
    publicKeyPem: r.public_key_pem,
    pinned: r.pinned === 1,
    registeredAt: new Date(r.registered_at).toISOString(),
  };
}

function rowToManifest(r: ManifestRow): SignedManifest {
  return {
    manifest: {
      contentId: r.content_id,
      contentType: r.content_type as ContentType,
      version: r.version_label,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      magnetUri: r.magnet_uri,
      ipfsCid: r.ipfs_cid,
      fallbackUrl: r.fallback_url,
      publisherKeyId: r.publisher_key_id,
      publishedAt: r.published_at,
    },
    signature: r.signature,
  };
}

function rowToSettings(r: SettingsRow): SeedingSettings {
  return {
    seedingEnabled: r.seeding_enabled === 1,
    uploadCapMbps: r.upload_cap_mbps,
    useRelay: r.use_relay === 1,
    fallbackToCdn: r.fallback_to_cdn === 1,
    peerFloor: r.peer_floor,
  };
}

// ─── Canonicalisation (deterministic JSON) ─────────────────────────────────

/**
 * Stable, sorted-key JSON used as the signing pre-image. Different
 * key orderings would produce different signatures — we serialise the
 * fields in a fixed order so the publisher CLI and the server agree.
 */
function canonicaliseManifest(m: ContentManifest): string {
  const ordered = {
    contentId: m.contentId,
    contentType: m.contentType,
    version: m.version,
    sizeBytes: m.sizeBytes,
    sha256: m.sha256.toLowerCase(),
    magnetUri: m.magnetUri,
    ipfsCid: m.ipfsCid,
    fallbackUrl: m.fallbackUrl,
    publisherKeyId: m.publisherKeyId,
    publishedAt: m.publishedAt,
  };
  return JSON.stringify(ordered);
}

// ─── Publisher key registry ────────────────────────────────────────────────

export function listPublisherKeys(): PublisherKey[] {
  __bootstrapP2pIfNeeded();
  const rows = getRawSqlite()
    .prepare<[], PublisherKeyRow>("SELECT * FROM p2p_publisher_keys ORDER BY key_id")
    .all();
  return rows.map(rowToKey);
}

export function getPublisherKey(keyId: string): PublisherKey | null {
  __bootstrapP2pIfNeeded();
  const row = getRawSqlite()
    .prepare<[string], PublisherKeyRow>(
      "SELECT * FROM p2p_publisher_keys WHERE key_id = ?",
    )
    .get(keyId);
  return row ? rowToKey(row) : null;
}

/**
 * Internal — not exposed via any HTTP route. Pinned publisher keys are
 * loaded once at boot from `OMNINITY_P2P_PINNED_KEYS` (or seeded by the
 * test runner). Allowing runtime callers to register `pinned: true`
 * keys would be a trust-anchor escalation: any tenant could mint a key,
 * pin it, and then publish malicious content signed by it.
 */
function internalRegisterPublisherKey(input: {
  keyId: string;
  label: string;
  publicKeyPem: string;
  pinned: boolean;
}): PublisherKey {
  const pub = createPublicKey(input.publicKeyPem);
  if (pub.asymmetricKeyType !== "ed25519") {
    throw new Error("Publisher key must be an Ed25519 public key");
  }
  const now = Date.now();
  getRawSqlite()
    .prepare(
      `INSERT INTO p2p_publisher_keys
         (key_id, label, public_key_pem, pinned, registered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id) DO UPDATE SET
         label = excluded.label,
         public_key_pem = excluded.public_key_pem,
         pinned = excluded.pinned,
         updated_at = excluded.updated_at,
         version = p2p_publisher_keys.version + 1`,
    )
    .run(input.keyId, input.label, input.publicKeyPem, input.pinned ? 1 : 0, now, now, now);
  logger.info({ keyId: input.keyId, pinned: input.pinned }, "Publisher signing key registered");
  return {
    keyId: input.keyId,
    label: input.label,
    publicKeyPem: input.publicKeyPem,
    pinned: input.pinned,
    registeredAt: new Date(now).toISOString(),
  };
}

interface PinnedKeyEnvEntry {
  keyId?: unknown;
  label?: unknown;
  publicKeyPem?: unknown;
}

function loadPinnedKeysFromEnv(): void {
  const raw = process.env["OMNINITY_P2P_PINNED_KEYS"];
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    logger.error({ err: e }, "OMNINITY_P2P_PINNED_KEYS is not valid JSON — ignoring");
    return;
  }
  if (!Array.isArray(parsed)) {
    logger.error("OMNINITY_P2P_PINNED_KEYS must be a JSON array");
    return;
  }
  for (const entry of parsed as PinnedKeyEnvEntry[]) {
    if (
      typeof entry?.keyId !== "string" ||
      typeof entry?.label !== "string" ||
      typeof entry?.publicKeyPem !== "string"
    ) {
      logger.warn({ entry }, "Skipping malformed pinned-key entry");
      continue;
    }
    try {
      internalRegisterPublisherKey({
        keyId: entry.keyId,
        label: entry.label,
        publicKeyPem: entry.publicKeyPem,
        pinned: true,
      });
    } catch (e) {
      logger.error({ err: e, keyId: entry.keyId }, "Failed to load pinned key");
    }
  }
}

// ─── Signature verification ────────────────────────────────────────────────

function verifySignedManifest(signed: SignedManifest): VerifyResult {
  const { manifest, signature } = signed;
  const key = getPublisherKey(manifest.publisherKeyId);
  if (!key) {
    return { contentId: manifest.contentId, ok: false, reason: "UNKNOWN_PUBLISHER_KEY" };
  }
  if (!key.pinned) {
    return { contentId: manifest.contentId, ok: false, reason: "PUBLISHER_KEY_NOT_PINNED" };
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    return { contentId: manifest.contentId, ok: false, reason: "INVALID_SHA256" };
  }
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(signature, "base64");
  } catch {
    return { contentId: manifest.contentId, ok: false, reason: "INVALID_SIGNATURE_ENCODING" };
  }
  const preimage = Buffer.from(canonicaliseManifest(manifest), "utf8");
  const pub = createPublicKey(key.publicKeyPem);
  const ok = cryptoVerify(null, preimage, pub, sigBuf);
  if (!ok) {
    return { contentId: manifest.contentId, ok: false, reason: "BAD_SIGNATURE" };
  }
  return { contentId: manifest.contentId, ok: true, reason: null };
}

// ─── Content registry ──────────────────────────────────────────────────────

export class ContentRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`Content manifest rejected: ${reason}`);
  }
}

export function publishContent(signed: SignedManifest): SignedManifest {
  const v = verifySignedManifest(signed);
  if (!v.ok) {
    logger.warn(
      { contentId: signed.manifest.contentId, reason: v.reason },
      "Rejected publish attempt — signature verification failed",
    );
    throw new ContentRejectedError(v.reason ?? "UNKNOWN");
  }
  const m = signed.manifest;
  const now = Date.now();
  getRawSqlite()
    .prepare(
      `INSERT INTO p2p_content_manifests
         (content_id, content_type, version_label, size_bytes, sha256,
          magnet_uri, ipfs_cid, fallback_url, publisher_key_id,
          published_at, signature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(content_id) DO UPDATE SET
         content_type = excluded.content_type,
         version_label = excluded.version_label,
         size_bytes = excluded.size_bytes,
         sha256 = excluded.sha256,
         magnet_uri = excluded.magnet_uri,
         ipfs_cid = excluded.ipfs_cid,
         fallback_url = excluded.fallback_url,
         publisher_key_id = excluded.publisher_key_id,
         published_at = excluded.published_at,
         signature = excluded.signature,
         updated_at = excluded.updated_at,
         version = p2p_content_manifests.version + 1`,
    )
    .run(
      m.contentId, m.contentType, m.version, m.sizeBytes, m.sha256,
      m.magnetUri, m.ipfsCid, m.fallbackUrl, m.publisherKeyId,
      m.publishedAt, signed.signature, now, now,
    );
  logger.info(
    {
      contentId: m.contentId,
      contentType: m.contentType,
      version: m.version,
      publisherKeyId: m.publisherKeyId,
    },
    "Signed content manifest published to P2P network",
  );
  return signed;
}

export function listContent(filter?: { contentType?: ContentType }): SignedManifest[] {
  __bootstrapP2pIfNeeded();
  const sqlite = getRawSqlite();
  const rows = filter?.contentType
    ? sqlite
        .prepare<[string], ManifestRow>(
          "SELECT * FROM p2p_content_manifests WHERE content_type = ? ORDER BY content_id",
        )
        .all(filter.contentType)
    : sqlite
        .prepare<[], ManifestRow>(
          "SELECT * FROM p2p_content_manifests ORDER BY content_id",
        )
        .all();
  return rows.map(rowToManifest);
}

export function getContent(contentId: string): SignedManifest | null {
  __bootstrapP2pIfNeeded();
  const row = getRawSqlite()
    .prepare<[string], ManifestRow>(
      "SELECT * FROM p2p_content_manifests WHERE content_id = ?",
    )
    .get(contentId);
  return row ? rowToManifest(row) : null;
}

/**
 * Verify a downloaded blob by re-checking the manifest signature *and*
 * confirming the caller's computed sha256 matches the manifest. Called
 * by the desktop shell after WebTorrent reports the swap is complete
 * and before the file is moved into the install directory.
 */
export function verifyDownloadedContent(
  contentId: string,
  computedSha256: string,
): VerifyResult {
  const signed = getContent(contentId);
  if (!signed) return { contentId, ok: false, reason: "UNKNOWN_CONTENT" };
  const sig = verifySignedManifest(signed);
  if (!sig.ok) return sig;
  if (computedSha256.toLowerCase() !== signed.manifest.sha256.toLowerCase()) {
    return { contentId, ok: false, reason: "SHA256_MISMATCH" };
  }
  return { contentId, ok: true, reason: null };
}

// ─── Swarm tracking ────────────────────────────────────────────────────────

export interface AnnounceInput {
  contentId: string;
  peerCount: number;
  uploadBytes?: number;
  downloadBytes?: number;
}

function classifyHealth(peerCount: number, settings: SeedingSettings): SwarmHealth {
  if (peerCount === 0 && settings.fallbackToCdn) return "fallback_active";
  if (peerCount < settings.peerFloor) return "low_peers";
  return "healthy";
}

export function announceSwarm(tenantId: string, input: AnnounceInput): SwarmStats {
  if (!getContent(input.contentId)) {
    throw new ContentRejectedError("UNKNOWN_CONTENT");
  }
  if (input.peerCount < 0 || !Number.isFinite(input.peerCount)) {
    throw new ContentRejectedError("INVALID_PEER_COUNT");
  }
  const settings = getSeedingSettings(tenantId);
  const map = getOrCreateSwarmMap(tenantId);
  const stats: SwarmStats = {
    contentId: input.contentId,
    peerCount: Math.floor(input.peerCount),
    uploadBytes: Math.max(0, Math.floor(input.uploadBytes ?? 0)),
    downloadBytes: Math.max(0, Math.floor(input.downloadBytes ?? 0)),
    lastSeenAt: new Date().toISOString(),
    health: classifyHealth(input.peerCount, settings),
  };
  map.set(input.contentId, stats);
  return stats;
}

export function getSwarm(tenantId: string, contentId: string): SwarmStats | null {
  return tenantSwarms.get(tenantId)?.get(contentId) ?? null;
}

export function listSwarms(tenantId: string): SwarmStats[] {
  return Array.from(tenantSwarms.get(tenantId)?.values() ?? []);
}

export function shouldFallbackToCdn(tenantId: string, contentId: string): boolean {
  const settings = getSeedingSettings(tenantId);
  if (!settings.fallbackToCdn) return false;
  const swarm = getSwarm(tenantId, contentId);
  if (!swarm) return true; // No data yet — be conservative.
  return swarm.peerCount < settings.peerFloor;
}

// ─── Settings ──────────────────────────────────────────────────────────────

export function getSeedingSettings(tenantId: string): SeedingSettings {
  __bootstrapP2pIfNeeded();
  const row = getRawSqlite()
    .prepare<[string], SettingsRow>(
      "SELECT * FROM p2p_seeding_settings WHERE tenant_id = ?",
    )
    .get(tenantId);
  return row ? rowToSettings(row) : { ...DEFAULT_SETTINGS };
}

export interface SeedingSettingsInput {
  seedingEnabled?: boolean;
  uploadCapMbps?: number | null;
  useRelay?: boolean;
  fallbackToCdn?: boolean;
  peerFloor?: number;
}

export function updateSeedingSettings(
  tenantId: string,
  input: SeedingSettingsInput,
): SeedingSettings {
  const cur = getSeedingSettings(tenantId);
  const next: SeedingSettings = { ...cur };
  if (input.seedingEnabled !== undefined) next.seedingEnabled = input.seedingEnabled;
  if (input.uploadCapMbps !== undefined) {
    if (input.uploadCapMbps !== null && (input.uploadCapMbps <= 0 || !Number.isFinite(input.uploadCapMbps))) {
      throw new Error("uploadCapMbps must be a positive number or null");
    }
    next.uploadCapMbps = input.uploadCapMbps;
  }
  if (input.useRelay !== undefined) next.useRelay = input.useRelay;
  if (input.fallbackToCdn !== undefined) next.fallbackToCdn = input.fallbackToCdn;
  if (input.peerFloor !== undefined) {
    if (!Number.isInteger(input.peerFloor) || input.peerFloor < 1 || input.peerFloor > 100) {
      throw new Error("peerFloor must be an integer between 1 and 100");
    }
    next.peerFloor = input.peerFloor;
  }
  const now = Date.now();
  getRawSqlite()
    .prepare(
      `INSERT INTO p2p_seeding_settings
         (tenant_id, seeding_enabled, upload_cap_mbps, use_relay,
          fallback_to_cdn, peer_floor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         seeding_enabled = excluded.seeding_enabled,
         upload_cap_mbps = excluded.upload_cap_mbps,
         use_relay = excluded.use_relay,
         fallback_to_cdn = excluded.fallback_to_cdn,
         peer_floor = excluded.peer_floor,
         updated_at = excluded.updated_at,
         version = p2p_seeding_settings.version + 1`,
    )
    .run(
      tenantId,
      next.seedingEnabled ? 1 : 0,
      next.uploadCapMbps,
      next.useRelay ? 1 : 0,
      next.fallbackToCdn ? 1 : 0,
      next.peerFloor,
      now,
      now,
    );
  // Re-classify health for every active swarm — a settings change can
  // flip a swarm from "healthy" to "low_peers" or vice versa.
  const map = tenantSwarms.get(tenantId);
  if (map) {
    for (const s of map.values()) {
      s.health = classifyHealth(s.peerCount, next);
    }
  }
  logger.info({ tenantId, settings: next }, "P2P seeding settings updated");
  return next;
}

// ─── Relays ────────────────────────────────────────────────────────────────

export function listRelays(): RelayNode[] {
  return defaultRelays();
}

// ─── Network overview (for the Settings → Network panel) ──────────────────

export function getNetworkOverview(tenantId: string): NetworkOverview {
  const swarms = listSwarms(tenantId);
  const totals = swarms.reduce(
    (acc, s) => {
      acc.peerCount += s.peerCount;
      acc.uploadBytes += s.uploadBytes;
      acc.downloadBytes += s.downloadBytes;
      acc.activeSwarms += 1;
      return acc;
    },
    { peerCount: 0, uploadBytes: 0, downloadBytes: 0, activeSwarms: 0 },
  );
  return {
    swarms,
    totals,
    settings: getSeedingSettings(tenantId),
    relays: listRelays(),
  };
}

// ─── SHA-256 helper (used by the publisher tooling tests) ──────────────────

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ─── Test-only seeding + signing helpers ───────────────────────────────────

/**
 * Test-only — generates an in-process Ed25519 keypair and registers the
 * public half as the pinned "op-root" publisher. The private half is
 * stored in this module's closure for `__signManifestForTests` only.
 * Guarded by `NODE_ENV === "test"` so the production path never accepts
 * a runtime-generated trust anchor.
 */
function ensureTestRootKey(): void {
  if (process.env["NODE_ENV"] !== "test") return;
  if (getPublisherKey("op-root")) return;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  testRootPrivateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  internalRegisterPublisherKey({
    keyId: "op-root",
    label: "Omninity Operator — Test Root Publisher",
    publicKeyPem,
    pinned: true,
  });
}

export function __signManifestForTests(manifest: ContentManifest): SignedManifest {
  ensureTestRootKey();
  if (!testRootPrivateKeyPem) throw new Error("test root key not initialised");
  const priv = createPrivateKey(testRootPrivateKeyPem);
  const preimage = Buffer.from(canonicaliseManifest(manifest), "utf8");
  const sig = cryptoSign(null, preimage, priv);
  return { manifest, signature: sig.toString("base64") };
}

export function __resetP2pForTests(): void {
  const sqlite = getRawSqlite();
  sqlite.exec("DELETE FROM p2p_content_manifests");
  sqlite.exec("DELETE FROM p2p_seeding_settings");
  sqlite.exec("DELETE FROM p2p_publisher_keys");
  tenantSwarms.clear();
  testRootPrivateKeyPem = null;
  loadPinnedKeysFromEnv();
  ensureTestRootKey();
}

/**
 * Boot — load the offline-published pinned key set from env. Production
 * deployments populate `OMNINITY_P2P_PINNED_KEYS` from a sealed config
 * store; the private halves live in an HSM the API server never sees.
 *
 * Deferred behind a guard so the migration runner has a chance to
 * create the schema before we issue our first INSERT.
 */
let bootstrapped = false;
export function __bootstrapP2pIfNeeded(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  try {
    loadPinnedKeysFromEnv();
    ensureTestRootKey();
  } catch (e) {
    logger.error({ err: e }, "Failed to bootstrap P2P key registry");
  }
}
