/**
 * Data-inventory service — powers the "What's on my machine" panel.
 *
 * Counts rows in every category of user data and returns the on-disk
 * size of the SQLite database file plus the workspace sandbox tree.
 * Pure aggregation; safe to call from read-only routes.
 */
import fs from "node:fs";
import path from "node:path";

import { count } from "drizzle-orm";

import {
  agentRuns,
  approvals,
  auditLogEntries,
  conversations,
  crashReports,
  db,
  getRawSqlite,
  integrations,
  kbDocuments,
  mediaAssets,
  memories,
  messages,
  networkCalls,
  privacyEvents,
  scheduledTasks,
  securityEvents,
  skills,
  taskQueueEntries,
  taskTemplates,
  telemetryEvents,
  toolCalls,
  workspaces,
  tenantScope,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

export interface InventoryCategory {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly itemCount: number;
}

export interface DataInventory {
  readonly categories: ReadonlyArray<InventoryCategory>;
  readonly totalItems: number;
  readonly databaseBytes: number;
  readonly workspaceBytes: number;
  readonly totalDiskBytes: number;
  readonly generatedAt: string;
}

interface CategoryDef {
  key: string;
  label: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
}

// Category catalogue is a fixed allow-list — every entry corresponds to
// a tenant-scoped table that the user has the right to inspect.
const CATEGORIES: ReadonlyArray<CategoryDef> = [
  { key: "conversations", label: "Conversations", description: "Chat threads with the agent.", table: conversations },
  { key: "messages", label: "Messages", description: "Individual chat messages.", table: messages },
  { key: "agent_runs", label: "Agent runs", description: "Plans, executions, and verifier passes.", table: agentRuns },
  { key: "tool_calls", label: "Tool calls", description: "Every tool invocation the agent made.", table: toolCalls },
  { key: "memories", label: "Memories", description: "Long-term memories about you.", table: memories },
  { key: "knowledge_documents", label: "Knowledge documents", description: "Documents indexed in your second brain.", table: kbDocuments },
  { key: "media_assets", label: "Media assets", description: "Generated images, audio, and video.", table: mediaAssets },
  { key: "skills", label: "Skills", description: "Installed and authored skills.", table: skills },
  { key: "approvals", label: "Approvals", description: "Approval gate decisions.", table: approvals },
  { key: "audit_log", label: "Audit log", description: "Tamper-evident audit chain entries.", table: auditLogEntries },
  { key: "privacy_events", label: "Privacy events", description: "Cross-boundary read / write log.", table: privacyEvents },
  { key: "security_events", label: "Security events", description: "Auth failures and security signals.", table: securityEvents },
  { key: "network_calls", label: "Network calls", description: "Logged outbound network calls.", table: networkCalls },
  { key: "telemetry_events", label: "Telemetry events", description: "Anonymised opt-in telemetry events.", table: telemetryEvents },
  { key: "crash_reports", label: "Crash reports", description: "Pending and submitted crash reports.", table: crashReports },
  { key: "integrations", label: "Integrations", description: "Connected third-party providers.", table: integrations },
  { key: "task_queue", label: "Task queue", description: "Queued and active background tasks.", table: taskQueueEntries },
  { key: "task_templates", label: "Task templates", description: "Saved reusable task templates.", table: taskTemplates },
  { key: "scheduled_tasks", label: "Scheduled tasks", description: "Recurring & one-shot scheduled tasks.", table: scheduledTasks },
  { key: "workspaces", label: "Workspaces", description: "Workspace settings and metadata.", table: workspaces },
];

async function safeCount(
  ctx: TenantContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
): Promise<number> {
  try {
    const rows = await db
      .select({ c: count() })
      .from(table)
      .where(tenantScope(ctx, table));
    return Number(rows[0]?.c ?? 0);
  } catch (e) {
    logger.warn({ err: e }, "data-inventory: failed to count table");
    return 0;
  }
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      // best-effort: ignore unreadable entries
    }
  }
  return total;
}

function sandboxRoot(): string {
  return process.env["SANDBOX_ROOT"] ?? path.resolve(process.cwd(), "data", "workspaces");
}

function databaseBytes(): number {
  try {
    const sqlite = getRawSqlite();
    const file = (sqlite as unknown as { name?: string }).name;
    if (!file || file === ":memory:") return 0;
    return fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    return 0;
  }
}

export async function getDataInventory(
  ctx: TenantContext,
): Promise<DataInventory> {
  const categories: InventoryCategory[] = [];
  let totalItems = 0;
  for (const def of CATEGORIES) {
    const itemCount = await safeCount(ctx, def.table);
    categories.push({
      key: def.key,
      label: def.label,
      description: def.description,
      itemCount,
    });
    totalItems += itemCount;
  }
  const dbBytes = databaseBytes();
  const wsBytes = dirSize(path.join(sandboxRoot(), ctx.tenantId));
  return {
    categories,
    totalItems,
    databaseBytes: dbBytes,
    workspaceBytes: wsBytes,
    totalDiskBytes: dbBytes + wsBytes,
    generatedAt: new Date().toISOString(),
  };
}
