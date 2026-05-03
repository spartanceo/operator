/**
 * /api/dr — Platform Disaster Recovery & Business Continuity (Task #59).
 *
 * Endpoints:
 *   GET  /posture                       overall DR posture for the dashboard
 *   POST /seed-runbooks                 idempotently install canonical runbooks
 *
 *   GET  /replicas                      list configured replicas
 *   POST /replicas                      register a replica
 *   POST /replicas/:id/probe            record a lag probe
 *   POST /replicas/:id/failover         record a failover with achieved RTO
 *
 *   GET  /snapshots                     list daily snapshots
 *   POST /snapshots                     record a fresh snapshot
 *   POST /snapshots/:id/verify          record verification verdict
 *   POST /snapshots/:id/restore         initiate restore to a shadow env
 *   GET  /snapshots/pitr-anchor         find a snapshot covering ?at=<ms>
 *
 *   GET  /storage-nodes                 list skill-distribution nodes
 *   POST /storage-nodes                 register a new node
 *   POST /storage-nodes/:id/probe       record a health probe
 *
 *   GET  /runbooks                      list runbooks
 *   GET  /runbooks/:scenario            fetch one runbook
 *
 *   GET  /drills                        list recent drill results
 *   POST /drills                        record a drill
 *
 *   GET  /incidents                     list incidents (?status=)
 *   POST /incidents                     open one
 *   POST /incidents/:id/close           close + post-incident report
 *
 *   GET  /alerts                        list alerts
 *   POST /alerts/:id/ack                acknowledge an alert
 *
 *   POST /monitor/tick                  run one monitor pass for the tenant
 */
import { Router, type IRouter } from "express";
import { z } from "zod";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { adminLimiter } from "../../middlewares/rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import {
  ackAlert,
  closeIncident,
  computePosture,
  failoverToReplica,
  findPitrAnchor,
  getRunbook,
  IncidentReportRequiredError,
  listAlerts,
  listDrills,
  listIncidents,
  listReplicas,
  listRunbooks,
  listSnapshots,
  listStorageNodes,
  openIncident,
  recordDrill,
  recordReplicaProbe,
  recordSnapshot,
  recordSnapshotVerification,
  restoreSnapshot,
  recordStorageNodeProbe,
  registerReplica,
  registerStorageNode,
  runMonitorTick,
  seedRunbooksForTenant,
} from "../../services/dr.service";

const router: IRouter = Router();

const SeveritySchema = z.enum(["P0", "P1", "P2"]);
const ReplicationModeSchema = z.enum(["synchronous", "asynchronous"]);

router.use(requireTenant());

router.get("/posture", async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok(await computePosture(ctx)));
  } catch (e) {
    next(e);
  }
});

router.post("/seed-runbooks", adminLimiter, async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    await seedRunbooksForTenant(ctx);
    res.json(ok({ seeded: true }));
  } catch (e) {
    next(e);
  }
});

// ─── Replicas ────────────────────────────────────────────────────────────

router.get("/replicas", async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok({ items: await listReplicas(ctx) }));
  } catch (e) {
    next(e);
  }
});

const RegisterReplicaSchema = z.object({
  name: z.string().min(1).max(120),
  region: z.string().max(60).optional(),
  availabilityZone: z.string().max(60).optional(),
  role: z.enum(["standby", "primary"]).optional(),
  replicationMode: ReplicationModeSchema,
  dataClass: z.string().min(1).max(60),
});

router.post("/replicas", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RegisterReplicaSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid replica payload", parsed.error.flatten()));
      return;
    }
    const id = await registerReplica(ctx, parsed.data);
    res.json(ok({ id }));
  } catch (e) {
    next(e);
  }
});

const ReplicaProbeSchema = z.object({
  lagSeconds: z.number().int().min(0),
  status: z.enum(["healthy", "lagging", "down", "promoted"]).optional(),
});

router.post("/replicas/:id/probe", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = ReplicaProbeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid probe payload", parsed.error.flatten()));
      return;
    }
    await recordReplicaProbe(ctx, String(req.params.id), parsed.data);
    res.json(ok({ recorded: true }));
  } catch (e) {
    next(e);
  }
});

const FailoverSchema = z.object({
  durationMs: z.number().int().min(0).max(60 * 60 * 1000),
  confirm: z.literal(true),
});

router.post("/replicas/:id/failover", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = FailoverSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Failover requires confirm=true and durationMs", parsed.error.flatten()));
      return;
    }
    await failoverToReplica(ctx, String(req.params.id), parsed.data.durationMs);
    res.json(ok({ promoted: true }));
  } catch (e) {
    next(e);
  }
});

// ─── Snapshots ───────────────────────────────────────────────────────────

router.get("/snapshots", async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const limit = Math.min(Number(req.query["limit"]) || 50, 200);
    res.json(ok({ items: await listSnapshots(ctx, limit) }));
  } catch (e) {
    next(e);
  }
});

const SnapshotSchema = z.object({
  snapshotKey: z.string().min(1).max(200),
  coldStorageUri: z.string().min(1).max(500),
  coldStorageProvider: z.string().max(60).optional(),
  region: z.string().max(60).optional(),
  sizeBytes: z.number().int().min(0),
  checksum: z.string().min(1).max(200),
  pitrLogStartAt: z.number().int().min(0),
  pitrLogEndAt: z.number().int().min(0),
  rowCount: z.number().int().min(0),
});

router.post("/snapshots", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = SnapshotSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid snapshot payload", parsed.error.flatten()));
      return;
    }
    const id = await recordSnapshot(ctx, parsed.data);
    res.json(ok({ id }));
  } catch (e) {
    next(e);
  }
});

const VerifySchema = z.object({
  verdict: z.enum(["verified", "failed"]),
  failureReason: z.string().max(2000).optional(),
});

router.post("/snapshots/:id/verify", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = VerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid verify payload", parsed.error.flatten()));
      return;
    }
    await recordSnapshotVerification(
      ctx,
      String(req.params.id),
      parsed.data.verdict,
      parsed.data.failureReason,
    );
    res.json(ok({ recorded: true }));
  } catch (e) {
    next(e);
  }
});

const RestoreSchema = z.object({
  pitrTargetAt: z.number().int().nonnegative().optional(),
  confirm: z.boolean(),
  reason: z.string().max(2000).optional(),
});

router.post("/snapshots/:id/restore", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = RestoreSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid restore payload", parsed.error.flatten()));
      return;
    }
    try {
      const result = await restoreSnapshot(ctx, String(req.params.id), parsed.data);
      res.json(ok(result));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(409).json(err("RESTORE_REJECTED", message));
    }
  } catch (e) {
    next(e);
  }
});

router.get("/snapshots/pitr-anchor", async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const at = Number(req.query["at"]);
    if (!Number.isFinite(at)) {
      res.status(400).json(err("VALIDATION", "Query param ?at=<unixMs> is required"));
      return;
    }
    const anchor = await findPitrAnchor(ctx, at);
    res.json(ok({ anchor }));
  } catch (e) {
    next(e);
  }
});

// ─── Storage nodes ───────────────────────────────────────────────────────

router.get("/storage-nodes", async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok({ items: await listStorageNodes(ctx) }));
  } catch (e) {
    next(e);
  }
});

const StorageNodeSchema = z.object({
  name: z.string().min(1).max(120),
  region: z.string().max(60).optional(),
  endpoint: z.string().min(1).max(500),
  capacityBytes: z.number().int().min(0).optional(),
});

router.post("/storage-nodes", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = StorageNodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid node payload", parsed.error.flatten()));
      return;
    }
    const id = await registerStorageNode(ctx, parsed.data);
    res.json(ok({ id }));
  } catch (e) {
    next(e);
  }
});

const NodeProbeSchema = z.object({
  status: z.enum(["healthy", "degraded", "offline"]),
  storedPackages: z.number().int().min(0).optional(),
  usedBytes: z.number().int().min(0).optional(),
});

router.post("/storage-nodes/:id/probe", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = NodeProbeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid probe payload", parsed.error.flatten()));
      return;
    }
    await recordStorageNodeProbe(
      ctx,
      String(req.params.id),
      parsed.data.status,
      parsed.data.storedPackages,
      parsed.data.usedBytes,
    );
    res.json(ok({ recorded: true }));
  } catch (e) {
    next(e);
  }
});

// ─── Runbooks ────────────────────────────────────────────────────────────

router.get("/runbooks", async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok({ items: await listRunbooks(ctx) }));
  } catch (e) {
    next(e);
  }
});

router.get("/runbooks/:scenario", async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const row = await getRunbook(ctx, String(req.params.scenario));
    if (!row) {
      res.status(404).json(err("NOT_FOUND", "Runbook not found"));
      return;
    }
    res.json(ok(row));
  } catch (e) {
    next(e);
  }
});

// ─── Drills ──────────────────────────────────────────────────────────────

router.get("/drills", async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok({ items: await listDrills(ctx) }));
  } catch (e) {
    next(e);
  }
});

const DrillCheckSchema = z.object({
  name: z.string().min(1).max(120),
  passed: z.boolean(),
  detail: z.string().max(500).optional(),
});

const DrillSchema = z.object({
  kind: z.enum(["monthly", "quarterly_failover", "manual"]),
  snapshotId: z.string().optional(),
  checks: z.array(DrillCheckSchema).min(1).max(50),
  actualRtoMs: z.number().int().min(0).optional(),
  actualRpoSeconds: z.number().int().min(0).optional(),
  notes: z.string().max(2000).optional(),
});

router.post("/drills", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = DrillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid drill payload", parsed.error.flatten()));
      return;
    }
    const id = await recordDrill(ctx, parsed.data);
    res.json(ok({ id }));
  } catch (e) {
    next(e);
  }
});

// ─── Incidents ───────────────────────────────────────────────────────────

router.get("/incidents", async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const status = req.query["status"]
      ? String(req.query["status"])
      : undefined;
    const allowed = ["open", "acknowledged", "resolved", "closed"] as const;
    const filter = (allowed as readonly string[]).includes(status ?? "")
      ? (status as (typeof allowed)[number])
      : undefined;
    res.json(ok({ items: await listIncidents(ctx, filter) }));
  } catch (e) {
    next(e);
  }
});

const OpenIncidentSchema = z.object({
  severityTier: SeveritySchema,
  scenario: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  runbookId: z.string().optional(),
});

router.post("/incidents", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = OpenIncidentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid incident payload", parsed.error.flatten()));
      return;
    }
    const id = await openIncident(ctx, parsed.data);
    res.json(ok({ id }));
  } catch (e) {
    next(e);
  }
});

const CloseIncidentSchema = z.object({
  timeline: z.string().max(8000).optional(),
  impact: z.string().max(4000).optional(),
  rootCause: z.string().max(4000).optional(),
  remediation: z.string().max(4000).optional(),
});

router.post("/incidents/:id/close", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = CloseIncidentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid close payload", parsed.error.flatten()));
      return;
    }
    await closeIncident(ctx, String(req.params.id), parsed.data);
    res.json(ok({ closed: true }));
  } catch (e) {
    if (e instanceof IncidentReportRequiredError) {
      res.status(409).json(err(e.code, e.message));
      return;
    }
    next(e);
  }
});

// ─── Alerts ──────────────────────────────────────────────────────────────

router.get("/alerts", async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    res.json(ok({ items: await listAlerts(ctx) }));
  } catch (e) {
    next(e);
  }
});

const AckSchema = z.object({ by: z.string().min(1).max(120) });

router.post("/alerts/:id/ack", adminLimiter, async (req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const parsed = AckSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(err("VALIDATION", "Invalid ack payload", parsed.error.flatten()));
      return;
    }
    await ackAlert(ctx, String(req.params.id), parsed.data.by);
    res.json(ok({ acknowledged: true }));
  } catch (e) {
    next(e);
  }
});

// ─── Monitor ─────────────────────────────────────────────────────────────

router.post("/monitor/tick", adminLimiter, async (_req, res, next) => {
  try {
    const ctx = requireTenantContext();
    const created = await runMonitorTick(ctx);
    res.json(ok({ alertIdsCreated: created }));
  } catch (e) {
    next(e);
  }
});

export default router;
