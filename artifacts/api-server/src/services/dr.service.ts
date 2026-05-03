/**
 * Platform Disaster Recovery & Business Continuity service (Task #59).
 *
 * Owns the platform-side DR controls — distinct from the user-side
 * backup/restore service (Task #20) which protects each user's local
 * Omninity Operator install. This service models:
 *
 *   - Hot-standby replicas with replication-mode (sync/async) and lag
 *     monitoring. Critical data classes (`payouts`, `subscriptions`)
 *     are required to be synchronously replicated; the monitor alerts
 *     when that invariant is violated.
 *   - Daily snapshots exported to geographically isolated cold storage
 *     with PITR transaction-log retention pointers (30-day window) and
 *     post-write integrity verification (`pending → verified | failed`).
 *   - Skill distribution storage nodes with a minimum-three-healthy
 *     redundancy guarantee.
 *   - Written DR runbooks per failure scenario, seeded from markdown
 *     files at boot time.
 *   - Monthly automated DR drills + quarterly full-failover tests with
 *     achieved RTO / RPO metrics for leadership dashboards.
 *   - Severity-tiered platform incidents (P0/P1/P2) with response SLAs
 *     and required post-incident report fields for any P0 or P1.
 *   - Append-only DR alert ledger.
 *
 * Tenant safety:
 *   Every read goes through `tenantScope(ctx, table)`, every write
 *   through `withTenantValues(ctx, …)`. The service is intentionally
 *   pure-data — actual replication / snapshot / failover side-effects
 *   are platform-infrastructure operations performed outside the
 *   application process; this service records intent and verdict so
 *   the API + admin UI have a single source of truth for DR posture.
 *
 * Monitoring:
 *   `runMonitorTick(ctx, now)` is pure — it walks every replica /
 *   storage node and emits the alerts that should fire given the
 *   current data. Safe to call repeatedly; duplicate alerts within a
 *   60s window are deduplicated.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { and, asc, desc, eq, gte } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  drAlerts,
  drDrills,
  drIncidents,
  drReplicas,
  drRunbooks,
  drSnapshots,
  drStorageNodes,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

// ─── Constants ────────────────────────────────────────────────────────────

/** Replication lag (seconds) past which a P1 alert fires. */
export const REPLICATION_LAG_ALERT_SECONDS = 10;
/** Minimum healthy storage nodes before the redundancy alert fires. */
export const MIN_HEALTHY_STORAGE_NODES = 3;
/** RTO / RPO targets, exposed for the leadership dashboard. */
export const RTO_TARGET_MS = 30 * 60 * 1000;
export const RPO_TARGET_SECONDS = 5 * 60;
/** PITR transaction-log retention window — 30 days. */
export const PITR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Critical data classes that MUST be synchronously replicated. */
export const CRITICAL_DATA_CLASSES = ["payouts", "subscriptions", "audit"] as const;
export type CriticalDataClass = (typeof CRITICAL_DATA_CLASSES)[number];

export type SeverityTier = "P0" | "P1" | "P2";
export type ReplicationMode = "synchronous" | "asynchronous";
export type ReplicaStatus = "healthy" | "lagging" | "down" | "promoted";
export type SnapshotVerifyStatus = "pending" | "verified" | "failed";
export type StorageNodeStatus = "healthy" | "degraded" | "offline";
export type IncidentStatus = "open" | "acknowledged" | "resolved" | "closed";
export type DrillKind = "monthly" | "quarterly_failover" | "manual";
export type DrillStatus = "pending" | "passed" | "failed" | "partial";
export type AlertKind =
  | "replication_lag"
  | "sync_replication_violation"
  | "snapshot_integrity_failure"
  | "storage_node_down"
  | "storage_redundancy_below_floor"
  | "backup_job_failure"
  | "primary_db_unreachable"
  | "snapshot_restore_initiated";

// Severity → response SLA in minutes (per task definition).
const SLA_BY_TIER: Record<SeverityTier, number> = {
  P0: 15,
  P1: 30,
  P2: 240,
};

// ─── Runbook seeding ──────────────────────────────────────────────────────

interface RunbookSeed {
  scenario: string;
  title: string;
  severityTier: SeverityTier;
  filename: string;
}

const RUNBOOK_SEEDS: ReadonlyArray<RunbookSeed> = [
  {
    scenario: "primary_db_failure",
    title: "Primary Database Failure",
    severityTier: "P0",
    filename: "primary_db_failure.md",
  },
  {
    scenario: "data_corruption",
    title: "Data Corruption",
    severityTier: "P0",
    filename: "data_corruption.md",
  },
  {
    scenario: "mass_deletion",
    title: "Accidental Mass Deletion",
    severityTier: "P1",
    filename: "mass_deletion.md",
  },
  {
    scenario: "region_outage",
    title: "Region Outage",
    severityTier: "P0",
    filename: "region_outage.md",
  },
  {
    scenario: "replica_lag",
    title: "Replica Lag Exceeding Threshold",
    severityTier: "P1",
    filename: "replica_lag.md",
  },
];

// The api-server is built as an ESM bundle (see build.mjs), so
// `import.meta.url` is always defined at runtime.
function runbookDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "dr", "runbooks");
}

function readRunbookBody(filename: string): string {
  const filePath = path.join(runbookDir(), filename);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), filePath },
      "Runbook file missing — seeding placeholder body",
    );
    return `# ${filename}\n\n_(runbook source file missing — please restore from version control)_`;
  }
}

/**
 * Seed the canonical runbooks for a tenant if they do not already
 * exist. Idempotent.
 */
export async function seedRunbooksForTenant(ctx: TenantContext): Promise<void> {
  const existing = await db
    .select({ scenario: drRunbooks.scenario })
    .from(drRunbooks)
    .where(tenantScope(ctx, drRunbooks));
  const haveScenarios = new Set(existing.map((r) => r.scenario));
  const now = Date.now();
  for (const seed of RUNBOOK_SEEDS) {
    if (haveScenarios.has(seed.scenario)) continue;
    const body = readRunbookBody(seed.filename);
    await db.insert(drRunbooks).values(
      withTenantValues(ctx, {
        id: nanoid(),
        scenario: seed.scenario,
        title: seed.title,
        severityTier: seed.severityTier,
        responseSlaMinutes: SLA_BY_TIER[seed.severityTier],
        body,
        lastReviewedAt: now,
      }),
    );
  }
}

// ─── Replicas ─────────────────────────────────────────────────────────────

export interface RegisterReplicaInput {
  name: string;
  region?: string;
  availabilityZone?: string;
  role?: "standby" | "primary";
  replicationMode: ReplicationMode;
  dataClass: string;
}

export async function registerReplica(
  ctx: TenantContext,
  input: RegisterReplicaInput,
): Promise<string> {
  const id = nanoid();
  await db.insert(drReplicas).values(
    withTenantValues(ctx, {
      id,
      name: input.name,
      region: input.region ?? "primary",
      availabilityZone: input.availabilityZone ?? "az-a",
      role: input.role ?? "standby",
      replicationMode: input.replicationMode,
      dataClass: input.dataClass,
      status: "healthy",
    }),
  );
  return id;
}

export async function listReplicas(ctx: TenantContext) {
  return db
    .select()
    .from(drReplicas)
    .where(tenantScope(ctx, drReplicas))
    .orderBy(asc(drReplicas.name));
}

export interface ReplicaProbeInput {
  lagSeconds: number;
  status?: ReplicaStatus;
}

export async function recordReplicaProbe(
  ctx: TenantContext,
  replicaId: string,
  probe: ReplicaProbeInput,
): Promise<void> {
  const now = Date.now();
  const computedStatus: ReplicaStatus =
    probe.status ??
    (probe.lagSeconds > REPLICATION_LAG_ALERT_SECONDS ? "lagging" : "healthy");
  await db
    .update(drReplicas)
    .set({
      lagSeconds: probe.lagSeconds,
      status: computedStatus,
      lastProbeAt: now,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, drReplicas), eq(drReplicas.id, replicaId)));
}

/**
 * Promote a standby to primary, recording the achieved RTO. Actual
 * cluster-side promotion is performed out-of-band; this records the
 * intent and verdict so the dashboard can show the failover history.
 */
export async function failoverToReplica(
  ctx: TenantContext,
  replicaId: string,
  durationMs: number,
): Promise<void> {
  const now = Date.now();
  await db
    .update(drReplicas)
    .set({
      role: "primary",
      status: "promoted",
      lastFailoverAt: now,
      lastFailoverDurationMs: durationMs,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, drReplicas), eq(drReplicas.id, replicaId)));
}

// ─── Snapshots ────────────────────────────────────────────────────────────

export interface RecordSnapshotInput {
  snapshotKey: string;
  coldStorageUri: string;
  coldStorageProvider?: string;
  region?: string;
  sizeBytes: number;
  checksum: string;
  pitrLogStartAt: number;
  pitrLogEndAt: number;
  rowCount: number;
}

export async function recordSnapshot(
  ctx: TenantContext,
  input: RecordSnapshotInput,
): Promise<string> {
  const id = nanoid();
  await db.insert(drSnapshots).values(
    withTenantValues(ctx, {
      id,
      snapshotKey: input.snapshotKey,
      coldStorageUri: input.coldStorageUri,
      coldStorageProvider: input.coldStorageProvider ?? "offsite",
      region: input.region ?? "eu-west",
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      pitrLogStartAt: input.pitrLogStartAt,
      pitrLogEndAt: input.pitrLogEndAt,
      verifyStatus: "pending",
      rowCount: input.rowCount,
    }),
  );
  return id;
}

/**
 * Record the verdict of a post-write integrity verification (the
 * restore-test against a shadow environment). Failed verifications
 * automatically emit a P0 alert.
 */
export async function recordSnapshotVerification(
  ctx: TenantContext,
  snapshotId: string,
  verdict: SnapshotVerifyStatus,
  failureReason?: string,
): Promise<void> {
  const now = Date.now();
  await db
    .update(drSnapshots)
    .set({
      verifyStatus: verdict,
      verifyAt: now,
      verifyFailureReason: verdict === "failed" ? (failureReason ?? "unknown") : null,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, drSnapshots), eq(drSnapshots.id, snapshotId)));

  if (verdict === "failed") {
    await emitAlert(ctx, {
      kind: "snapshot_integrity_failure",
      severityTier: "P0",
      subject: `Snapshot ${snapshotId} failed integrity verification`,
      message:
        failureReason ?? "Restore-test against shadow environment did not succeed.",
      details: { snapshotId },
    });
  }
}

export async function listSnapshots(ctx: TenantContext, limit = 50) {
  return db
    .select()
    .from(drSnapshots)
    .where(tenantScope(ctx, drSnapshots))
    .orderBy(desc(drSnapshots.createdAt))
    .limit(limit);
}

/**
 * Identify the snapshot suitable for a point-in-time restore at the
 * given wall-clock millisecond. Picks the most recent verified
 * snapshot whose PITR log window covers the target.
 */
export async function findPitrAnchor(ctx: TenantContext, targetAt: number) {
  const oldest = Date.now() - PITR_RETENTION_MS;
  if (targetAt < oldest) return null;
  const candidates = await db
    .select()
    .from(drSnapshots)
    .where(
      and(tenantScope(ctx, drSnapshots), eq(drSnapshots.verifyStatus, "verified")),
    )
    .orderBy(desc(drSnapshots.pitrLogEndAt));
  return (
    candidates.find(
      (s) =>
        (s.pitrLogStartAt ?? 0) <= targetAt && (s.pitrLogEndAt ?? 0) >= targetAt,
    ) ?? null
  );
}

/**
 * Initiate a restore of a verified snapshot to a shadow environment.
 *
 * The api-server does not perform the actual byte-level restore — that
 * is the responsibility of the storage tier and the on-call operator
 * following the runbook. This function:
 *   - validates the snapshot is `verified` (failed/pending snapshots
 *     are not restorable),
 *   - validates the optional `pitrTargetAt` falls inside the
 *     snapshot's PITR window,
 *   - allocates a deterministic shadow snapshot key the operator
 *     references when running the restore tool,
 *   - records an informational alert so the activity is auditable,
 *   - returns a restore manifest the runbook step expects.
 */
export interface RestoreSnapshotInput {
  pitrTargetAt?: number;
  confirm: boolean;
  reason?: string;
}

export interface RestoreSnapshotResult {
  snapshotId: string;
  shadowSnapshotKey: string;
  pitrTargetAt: number | null;
  coldStorageUri: string;
  checksum: string | null;
  initiatedAt: number;
}

export async function restoreSnapshot(
  ctx: TenantContext,
  snapshotId: string,
  input: RestoreSnapshotInput,
): Promise<RestoreSnapshotResult> {
  if (!input.confirm) {
    throw new Error("Restore must be explicitly confirmed (confirm=true).");
  }
  const [snapshot] = await db
    .select()
    .from(drSnapshots)
    .where(and(tenantScope(ctx, drSnapshots), eq(drSnapshots.id, snapshotId)))
    .limit(1);
  if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);
  if (snapshot.verifyStatus !== "verified") {
    throw new Error(
      `Snapshot ${snapshotId} is not verified (status=${snapshot.verifyStatus}); refusing to restore.`,
    );
  }
  const pitrTargetAt = input.pitrTargetAt ?? null;
  if (pitrTargetAt !== null) {
    const start = snapshot.pitrLogStartAt ?? 0;
    const end = snapshot.pitrLogEndAt ?? 0;
    if (pitrTargetAt < start || pitrTargetAt > end) {
      throw new Error(
        `pitrTargetAt ${pitrTargetAt} is outside snapshot window [${start}..${end}].`,
      );
    }
  }
  const initiatedAt = Date.now();
  const shadowSnapshotKey = `${snapshot.snapshotKey}.shadow.${initiatedAt}`;
  await emitAlert(ctx, {
    kind: "snapshot_restore_initiated",
    severityTier: "P2",
    subject: `Restore initiated for snapshot ${snapshotId}`,
    message:
      input.reason ??
      "Operator-triggered restore to shadow environment per DR runbook.",
    details: { snapshotId, shadowSnapshotKey, pitrTargetAt },
  });
  return {
    snapshotId,
    shadowSnapshotKey,
    pitrTargetAt,
    coldStorageUri: snapshot.coldStorageUri,
    checksum: snapshot.checksum,
    initiatedAt,
  };
}

// ─── Storage nodes ────────────────────────────────────────────────────────

export async function listStorageNodes(ctx: TenantContext) {
  return db
    .select()
    .from(drStorageNodes)
    .where(tenantScope(ctx, drStorageNodes))
    .orderBy(asc(drStorageNodes.name));
}

export interface RegisterStorageNodeInput {
  name: string;
  region?: string;
  endpoint: string;
  capacityBytes?: number;
}

export async function registerStorageNode(
  ctx: TenantContext,
  input: RegisterStorageNodeInput,
): Promise<string> {
  const id = nanoid();
  await db.insert(drStorageNodes).values(
    withTenantValues(ctx, {
      id,
      name: input.name,
      region: input.region ?? "eu-west",
      endpoint: input.endpoint,
      capacityBytes: input.capacityBytes ?? 0,
      status: "healthy",
    }),
  );
  return id;
}

export async function recordStorageNodeProbe(
  ctx: TenantContext,
  nodeId: string,
  status: StorageNodeStatus,
  storedPackages?: number,
  usedBytes?: number,
): Promise<void> {
  const now = Date.now();
  await db
    .update(drStorageNodes)
    .set({
      status,
      storedPackages: storedPackages ?? 0,
      usedBytes: usedBytes ?? 0,
      lastProbeAt: now,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, drStorageNodes), eq(drStorageNodes.id, nodeId)));
}

// ─── Drills ───────────────────────────────────────────────────────────────

export interface DrillCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface RunDrillInput {
  kind: DrillKind;
  snapshotId?: string;
  checks: ReadonlyArray<DrillCheck>;
  actualRtoMs?: number;
  actualRpoSeconds?: number;
  notes?: string;
}

export async function recordDrill(
  ctx: TenantContext,
  input: RunDrillInput,
): Promise<string> {
  const id = nanoid();
  const now = Date.now();
  const passedCount = input.checks.filter((c) => c.passed).length;
  const overallStatus: DrillStatus =
    passedCount === input.checks.length
      ? "passed"
      : passedCount === 0
        ? "failed"
        : "partial";
  await db.insert(drDrills).values(
    withTenantValues(ctx, {
      id,
      kind: input.kind,
      snapshotId: input.snapshotId ?? null,
      overallStatus,
      checks: JSON.stringify(input.checks),
      actualRtoMs: input.actualRtoMs ?? null,
      actualRpoSeconds: input.actualRpoSeconds ?? null,
      startedAt: now,
      completedAt: now,
      notes: input.notes ?? null,
    }),
  );
  return id;
}

export async function listDrills(ctx: TenantContext, limit = 50) {
  const rows = await db
    .select()
    .from(drDrills)
    .where(tenantScope(ctx, drDrills))
    .orderBy(desc(drDrills.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, checks: safeParseChecks(r.checks) }));
}

function safeParseChecks(raw: string): ReadonlyArray<DrillCheck> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DrillCheck[]) : [];
  } catch {
    return [];
  }
}

// ─── Incidents ────────────────────────────────────────────────────────────

export interface OpenIncidentInput {
  severityTier: SeverityTier;
  scenario: string;
  title: string;
  summary: string;
  runbookId?: string;
}

export class IncidentReportRequiredError extends Error {
  readonly code = "POST_INCIDENT_REPORT_REQUIRED";
  constructor() {
    super(
      "P0 / P1 incidents require timeline, impact, rootCause, and remediation before close.",
    );
  }
}

export async function openIncident(
  ctx: TenantContext,
  input: OpenIncidentInput,
): Promise<string> {
  const id = nanoid();
  await db.insert(drIncidents).values(
    withTenantValues(ctx, {
      id,
      severityTier: input.severityTier,
      scenario: input.scenario,
      title: input.title,
      summary: input.summary,
      runbookId: input.runbookId ?? null,
      status: "open",
      detectedAt: Date.now(),
    }),
  );
  return id;
}

export interface CloseIncidentInput {
  timeline: string;
  impact: string;
  rootCause: string;
  remediation: string;
}

export async function closeIncident(
  ctx: TenantContext,
  incidentId: string,
  report: Partial<CloseIncidentInput>,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(drIncidents)
    .where(and(tenantScope(ctx, drIncidents), eq(drIncidents.id, incidentId)))
    .limit(1);
  if (!existing) throw new Error(`Incident ${incidentId} not found`);

  const requiresReport =
    existing.severityTier === "P0" || existing.severityTier === "P1";
  if (requiresReport) {
    if (
      !report.timeline?.trim() ||
      !report.impact?.trim() ||
      !report.rootCause?.trim() ||
      !report.remediation?.trim()
    ) {
      throw new IncidentReportRequiredError();
    }
  }

  const now = Date.now();
  await db
    .update(drIncidents)
    .set({
      status: "closed",
      resolvedAt: now,
      timeline: report.timeline ?? existing.timeline,
      impact: report.impact ?? existing.impact,
      rootCause: report.rootCause ?? existing.rootCause,
      remediation: report.remediation ?? existing.remediation,
      updatedAt: now,
    })
    .where(and(tenantScope(ctx, drIncidents), eq(drIncidents.id, incidentId)));
}

export async function listIncidents(ctx: TenantContext, status?: IncidentStatus) {
  if (status) {
    return db
      .select()
      .from(drIncidents)
      .where(and(tenantScope(ctx, drIncidents), eq(drIncidents.status, status)))
      .orderBy(desc(drIncidents.createdAt));
  }
  return db
    .select()
    .from(drIncidents)
    .where(tenantScope(ctx, drIncidents))
    .orderBy(desc(drIncidents.createdAt));
}

// ─── Alerts ───────────────────────────────────────────────────────────────

export interface EmitAlertInput {
  kind: AlertKind;
  severityTier: SeverityTier;
  subject: string;
  message: string;
  details?: Record<string, unknown>;
  incidentId?: string;
}

export async function emitAlert(
  ctx: TenantContext,
  input: EmitAlertInput,
): Promise<string> {
  const id = nanoid();
  await db.insert(drAlerts).values(
    withTenantValues(ctx, {
      id,
      kind: input.kind,
      severityTier: input.severityTier,
      subject: input.subject,
      message: input.message,
      details: input.details ? JSON.stringify(input.details) : null,
      incidentId: input.incidentId ?? null,
    }),
  );
  logger.warn(
    {
      alertId: id,
      kind: input.kind,
      severity: input.severityTier,
      tenantId: ctx.tenantId,
    },
    `DR alert: ${input.subject}`,
  );
  return id;
}

export async function listAlerts(ctx: TenantContext, limit = 100) {
  return db
    .select()
    .from(drAlerts)
    .where(tenantScope(ctx, drAlerts))
    .orderBy(desc(drAlerts.createdAt))
    .limit(limit);
}

export async function ackAlert(
  ctx: TenantContext,
  alertId: string,
  by: string,
): Promise<void> {
  const now = Date.now();
  await db
    .update(drAlerts)
    .set({ acknowledgedAt: now, acknowledgedBy: by, updatedAt: now })
    .where(and(tenantScope(ctx, drAlerts), eq(drAlerts.id, alertId)));
}

// ─── Runbooks ─────────────────────────────────────────────────────────────

export async function listRunbooks(ctx: TenantContext) {
  return db
    .select()
    .from(drRunbooks)
    .where(tenantScope(ctx, drRunbooks))
    .orderBy(asc(drRunbooks.severityTier), asc(drRunbooks.scenario));
}

export async function getRunbook(ctx: TenantContext, scenario: string) {
  const [row] = await db
    .select()
    .from(drRunbooks)
    .where(and(tenantScope(ctx, drRunbooks), eq(drRunbooks.scenario, scenario)))
    .limit(1);
  return row ?? null;
}

// ─── Posture / dashboard ──────────────────────────────────────────────────

export interface DrPosture {
  rtoTargetMs: number;
  rpoTargetSeconds: number;
  pitrRetentionDays: number;
  replicas: {
    total: number;
    healthy: number;
    lagging: number;
    down: number;
    syncCriticalOk: boolean;
  };
  snapshots: {
    total: number;
    verified: number;
    failed: number;
    latestVerifiedAt: number | null;
  };
  storageNodes: {
    total: number;
    healthy: number;
    redundancyOk: boolean;
  };
  openIncidents: number;
  unacknowledgedAlerts: number;
  lastDrillAt: number | null;
  lastDrillStatus: DrillStatus | null;
  lastFailoverDurationMs: number | null;
}

export async function computePosture(ctx: TenantContext): Promise<DrPosture> {
  const [replicas, snapshots, nodes, incidents, alerts, drills] =
    await Promise.all([
      listReplicas(ctx),
      listSnapshots(ctx, 200),
      listStorageNodes(ctx),
      listIncidents(ctx, "open"),
      listAlerts(ctx, 200),
      listDrills(ctx, 1),
    ]);

  const healthy = replicas.filter((r) => r.status === "healthy").length;
  const lagging = replicas.filter((r) => r.status === "lagging").length;
  const down = replicas.filter((r) => r.status === "down").length;
  const syncCriticalOk = replicas
    .filter((r) =>
      (CRITICAL_DATA_CLASSES as readonly string[]).includes(r.dataClass),
    )
    .every((r) => r.replicationMode === "synchronous");

  const verified = snapshots.filter((s) => s.verifyStatus === "verified");
  const failed = snapshots.filter((s) => s.verifyStatus === "failed").length;
  const latestVerifiedAt =
    verified.length > 0
      ? Math.max(...verified.map((s) => s.verifyAt ?? s.createdAt))
      : null;

  const healthyNodes = nodes.filter((n) => n.status === "healthy").length;
  const lastDrill = drills[0] ?? null;
  const lastFailover =
    replicas.length > 0
      ? Math.max(...replicas.map((r) => r.lastFailoverDurationMs ?? 0)) || null
      : null;

  return {
    rtoTargetMs: RTO_TARGET_MS,
    rpoTargetSeconds: RPO_TARGET_SECONDS,
    pitrRetentionDays: 30,
    replicas: {
      total: replicas.length,
      healthy,
      lagging,
      down,
      syncCriticalOk,
    },
    snapshots: {
      total: snapshots.length,
      verified: verified.length,
      failed,
      latestVerifiedAt,
    },
    storageNodes: {
      total: nodes.length,
      healthy: healthyNodes,
      redundancyOk: healthyNodes >= MIN_HEALTHY_STORAGE_NODES,
    },
    openIncidents: incidents.length,
    unacknowledgedAlerts: alerts.filter((a) => a.acknowledgedAt === null).length,
    lastDrillAt: lastDrill?.completedAt ?? lastDrill?.startedAt ?? null,
    lastDrillStatus: (lastDrill?.overallStatus as DrillStatus | undefined) ?? null,
    lastFailoverDurationMs: lastFailover,
  };
}

// ─── Monitor tick ─────────────────────────────────────────────────────────

/**
 * Single monitor pass for one tenant. Pure — produces the alerts that
 * SHOULD fire given the current data; safe to call repeatedly.
 *
 * Triggers:
 *   - replica.lagSeconds > REPLICATION_LAG_ALERT_SECONDS → P1 lag alert
 *   - critical-class replica with replicationMode != 'synchronous' → P0
 *   - storage node count below MIN_HEALTHY_STORAGE_NODES → P1
 *   - storage node status == 'offline' → P1 per node
 *
 * Returns the ids of alerts created (post-deduplication).
 */
export async function runMonitorTick(
  ctx: TenantContext,
  now: number = Date.now(),
): Promise<ReadonlyArray<string>> {
  const cutoff = now - 60_000;

  const [replicas, nodes, recent] = await Promise.all([
    listReplicas(ctx),
    listStorageNodes(ctx),
    db
      .select({
        kind: drAlerts.kind,
        subject: drAlerts.subject,
      })
      .from(drAlerts)
      .where(and(tenantScope(ctx, drAlerts), gte(drAlerts.createdAt, cutoff))),
  ]);
  const recentKeys = new Set(recent.map((r) => `${r.kind}:${r.subject}`));
  const created: string[] = [];

  async function maybeEmit(input: EmitAlertInput): Promise<void> {
    const key = `${input.kind}:${input.subject}`;
    if (recentKeys.has(key)) return;
    recentKeys.add(key);
    created.push(await emitAlert(ctx, input));
  }

  for (const replica of replicas) {
    if (replica.lagSeconds > REPLICATION_LAG_ALERT_SECONDS) {
      await maybeEmit({
        kind: "replication_lag",
        severityTier: "P1",
        subject: `Replication lag on ${replica.name} = ${replica.lagSeconds}s`,
        message: `Lag exceeds the ${REPLICATION_LAG_ALERT_SECONDS}s threshold.`,
        details: { replicaId: replica.id, lagSeconds: replica.lagSeconds },
      });
    }
    if (
      (CRITICAL_DATA_CLASSES as readonly string[]).includes(replica.dataClass) &&
      replica.replicationMode !== "synchronous"
    ) {
      await maybeEmit({
        kind: "sync_replication_violation",
        severityTier: "P0",
        subject: `Critical replica ${replica.name} is not synchronous`,
        message: `Data class '${replica.dataClass}' must be synchronously replicated.`,
        details: { replicaId: replica.id, dataClass: replica.dataClass },
      });
    }
  }

  const healthyNodes = nodes.filter((n) => n.status === "healthy").length;
  if (nodes.length > 0 && healthyNodes < MIN_HEALTHY_STORAGE_NODES) {
    await maybeEmit({
      kind: "storage_redundancy_below_floor",
      severityTier: "P1",
      subject: `Skill storage healthy node count = ${healthyNodes} (< ${MIN_HEALTHY_STORAGE_NODES})`,
      message:
        "Skill download redundancy guarantee violated — bring an additional storage node online.",
      details: { healthyNodes, total: nodes.length },
    });
  }

  for (const node of nodes) {
    if (node.status === "offline") {
      await maybeEmit({
        kind: "storage_node_down",
        severityTier: "P1",
        subject: `Storage node ${node.name} is offline`,
        message: "Probe reported the node as unreachable.",
        details: { nodeId: node.id, region: node.region },
      });
    }
  }

  return created;
}
