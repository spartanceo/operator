/**
 * Status page service — per-component health and the published incident
 * timeline shown on the in-app status page (Task #34).
 *
 * All status rows live under the SYSTEM tenant — these are platform-wide
 * services, not per-tenant resources. The route layer therefore reads
 * without a tenant context.
 */
import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  serviceStatusComponents,
  serviceStatusIncidents,
  SYSTEM_TENANT_ID,
  SYSTEM_WORKSPACE_ID,
  tenantScope,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

const SYSTEM_CTX: TenantContext = {
  tenantId: SYSTEM_TENANT_ID,
  workspaceId: SYSTEM_WORKSPACE_ID,
  requestId: "system-status",
};

// tier-review: bounded — fixed enum, never grows past code-defined values
const COMPONENT_STATUSES = new Set([
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
]);

// tier-review: bounded — fixed enum, never grows past code-defined values
const INCIDENT_STATUSES = new Set([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);

// tier-review: bounded — fixed enum, never grows past code-defined values
const INCIDENT_SEVERITIES = new Set(["none", "minor", "major", "critical"]);

export class StatusValidationError extends Error {
  override readonly name = "StatusValidationError";
  readonly code = "STATUS_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export interface StatusComponentRow {
  id: string;
  componentKey: string;
  label: string;
  status: string;
  message: string;
  sortOrder: number;
  updatedAt: string;
}

export interface StatusIncidentRow {
  id: string;
  title: string;
  body: string;
  status: string;
  severity: string;
  affectedComponents: string[];
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

function componentRow(
  r: typeof serviceStatusComponents.$inferSelect,
): StatusComponentRow {
  return {
    id: r.id,
    componentKey: r.componentKey,
    label: r.label,
    status: r.status,
    message: r.message,
    sortOrder: r.sortOrder,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

function incidentRow(
  r: typeof serviceStatusIncidents.$inferSelect,
): StatusIncidentRow {
  const affected = r.affectedComponents
    ? r.affectedComponents.split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    severity: r.severity,
    affectedComponents: affected,
    startedAt: new Date(r.startedAt).toISOString(),
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listStatusComponents(): Promise<StatusComponentRow[]> {
  const rows = await db
    .select()
    .from(serviceStatusComponents)
    .where(tenantScope(SYSTEM_CTX, serviceStatusComponents))
    .orderBy(serviceStatusComponents.sortOrder);
  return rows.map(componentRow);
}

export interface UpdateComponentInput {
  componentKey: string;
  status: string;
  message?: string;
}

export async function updateComponentStatus(
  input: UpdateComponentInput,
): Promise<StatusComponentRow> {
  if (!COMPONENT_STATUSES.has(input.status)) {
    throw new StatusValidationError(`invalid status "${input.status}"`);
  }
  await db
    .update(serviceStatusComponents)
    .set({
      status: input.status,
      message: input.message?.trim() ?? "",
      updatedAt: Date.now(),
      version: sql`${serviceStatusComponents.version} + 1`,
    })
    .where(eq(serviceStatusComponents.componentKey, input.componentKey));
  const rows = await db
    .select()
    .from(serviceStatusComponents)
    .where(eq(serviceStatusComponents.componentKey, input.componentKey))
    .limit(1);
  if (!rows[0]) throw new StatusValidationError("component not found");
  logger.info(
    { component: input.componentKey, status: input.status },
    "Status component updated",
  );
  return componentRow(rows[0]);
}

export async function listActiveIncidents(): Promise<StatusIncidentRow[]> {
  const rows = await db
    .select()
    .from(serviceStatusIncidents)
    .where(tenantScope(SYSTEM_CTX, serviceStatusIncidents))
    .orderBy(desc(serviceStatusIncidents.startedAt))
    .limit(20);
  return rows.map(incidentRow);
}

export interface CreateIncidentInput {
  title: string;
  body?: string;
  severity?: string;
  affectedComponents?: string[];
}

export async function createIncident(
  input: CreateIncidentInput,
): Promise<StatusIncidentRow> {
  const title = input.title.trim();
  if (title.length === 0 || title.length > 200) {
    throw new StatusValidationError("title required (≤200 chars)");
  }
  const severity =
    input.severity && INCIDENT_SEVERITIES.has(input.severity)
      ? input.severity
      : "minor";
  const id = `inc_${nanoid()}`;
  const inserted = await db
    .insert(serviceStatusIncidents)
    .values({
      id,
      tenantId: SYSTEM_TENANT_ID,
      workspaceId: SYSTEM_WORKSPACE_ID,
      title,
      body: input.body?.trim() ?? "",
      severity,
      affectedComponents: (input.affectedComponents ?? []).join(","),
    })
    .returning();
  return incidentRow(inserted[0]!);
}

export interface UpdateIncidentInput {
  id: string;
  status?: string;
  body?: string;
  severity?: string;
}

export async function updateIncident(
  input: UpdateIncidentInput,
): Promise<StatusIncidentRow> {
  const updates: Partial<typeof serviceStatusIncidents.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (input.status !== undefined) {
    if (!INCIDENT_STATUSES.has(input.status)) {
      throw new StatusValidationError(`invalid status "${input.status}"`);
    }
    updates.status = input.status;
    if (input.status === "resolved") {
      updates.resolvedAt = Date.now();
    }
  }
  if (input.body !== undefined) updates.body = input.body.trim();
  if (input.severity !== undefined) {
    if (!INCIDENT_SEVERITIES.has(input.severity)) {
      throw new StatusValidationError(`invalid severity "${input.severity}"`);
    }
    updates.severity = input.severity;
  }
  await db
    .update(serviceStatusIncidents)
    .set({ ...updates, version: sql`${serviceStatusIncidents.version} + 1` })
    .where(eq(serviceStatusIncidents.id, input.id));
  const rows = await db
    .select()
    .from(serviceStatusIncidents)
    .where(eq(serviceStatusIncidents.id, input.id))
    .limit(1);
  if (!rows[0]) throw new StatusValidationError("incident not found");
  return incidentRow(rows[0]);
}

export interface PublicStatusSnapshot {
  overall: string;
  components: StatusComponentRow[];
  activeIncidents: StatusIncidentRow[];
  generatedAt: string;
}

/**
 * Aggregated status payload powering the in-app status indicator. The
 * "overall" field collapses every component status into a single
 * traffic-light value.
 */
export async function getPublicStatus(): Promise<PublicStatusSnapshot> {
  const components = await listStatusComponents();
  const activeIncidents = (await listActiveIncidents()).filter(
    (i) => i.status !== "resolved",
  );
  let overall: string = "operational";
  for (const c of components) {
    if (c.status === "major_outage") {
      overall = "major_outage";
      break;
    }
    if (c.status === "partial_outage" && overall !== "major_outage") {
      overall = "partial_outage";
    } else if (
      c.status === "degraded" &&
      overall !== "major_outage" &&
      overall !== "partial_outage"
    ) {
      overall = "degraded";
    } else if (c.status === "maintenance" && overall === "operational") {
      overall = "maintenance";
    }
  }
  return {
    overall,
    components,
    activeIncidents,
    generatedAt: new Date().toISOString(),
  };
}
