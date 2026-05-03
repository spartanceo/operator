/**
 * Audit alert-rule engine (Task #53).
 *
 * IT admins define threshold rules over the audit stream — for example
 * "alert me if any actor emits more than 50 file_op events in 60
 * seconds". Whenever an audit row that matches a rule's predicate is
 * appended, the engine runs the windowed count and, if the threshold
 * is crossed, appends an `audit_alerts` row + dispatches an in-app
 * notification.
 *
 * The evaluator is invoked from `audit.service.appendAuditEntry` after
 * the row is persisted. To break the import cycle (audit.service imports
 * this module), the evaluator imports the count helper from
 * `audit.service` lazily.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  auditAlertRules,
  auditAlerts,
  buildPage,
  db,
  decodeCursor,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

export interface AuditAlertRuleRow {
  readonly id: string;
  readonly name: string;
  readonly actionType: string | null;
  readonly actor: string | null;
  readonly thresholdCount: number;
  readonly windowSeconds: number;
  readonly enabled: boolean;
  readonly lastTriggeredAt: string | null;
  readonly createdAt: string;
}

function ruleToRow(r: typeof auditAlertRules.$inferSelect): AuditAlertRuleRow {
  return {
    id: r.id,
    name: r.name,
    actionType: r.actionType,
    actor: r.actor,
    thresholdCount: r.thresholdCount,
    windowSeconds: r.windowSeconds,
    enabled: Boolean(r.enabled),
    lastTriggeredAt: r.lastTriggeredAt ? new Date(r.lastTriggeredAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export interface CreateAlertRuleInput {
  readonly name: string;
  readonly actionType?: string | null;
  readonly actor?: string | null;
  readonly thresholdCount: number;
  readonly windowSeconds: number;
  readonly enabled?: boolean;
}

export async function listAlertRules(ctx: TenantContext): Promise<AuditAlertRuleRow[]> {
  const rows = await db
    .select()
    .from(auditAlertRules)
    .where(tenantScope(ctx, auditAlertRules))
    .orderBy(desc(auditAlertRules.createdAt));
  return rows.map(ruleToRow);
}

export async function createAlertRule(
  ctx: TenantContext,
  input: CreateAlertRuleInput,
): Promise<AuditAlertRuleRow> {
  const id = `aar_${nanoid()}`;
  const now = Date.now();
  await db.insert(auditAlertRules).values(
    withTenantValues(ctx, {
      id,
      name: input.name,
      actionType: input.actionType ?? null,
      actor: input.actor ?? null,
      thresholdCount: Math.max(1, Math.min(100000, input.thresholdCount)),
      windowSeconds: Math.max(1, Math.min(86400, input.windowSeconds)),
      enabled: input.enabled ?? true,
      lastTriggeredAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }),
  );
  const fresh = await db
    .select()
    .from(auditAlertRules)
    .where(and(tenantScope(ctx, auditAlertRules), eq(auditAlertRules.id, id)))
    .limit(1);
  return ruleToRow(fresh[0]!);
}

export async function updateAlertRule(
  ctx: TenantContext,
  id: string,
  patch: Partial<CreateAlertRuleInput>,
): Promise<AuditAlertRuleRow | null> {
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.name !== undefined) updates["name"] = patch.name;
  if (patch.actionType !== undefined) updates["actionType"] = patch.actionType;
  if (patch.actor !== undefined) updates["actor"] = patch.actor;
  if (patch.thresholdCount !== undefined) {
    updates["thresholdCount"] = Math.max(1, Math.min(100000, patch.thresholdCount));
  }
  if (patch.windowSeconds !== undefined) {
    updates["windowSeconds"] = Math.max(1, Math.min(86400, patch.windowSeconds));
  }
  if (patch.enabled !== undefined) updates["enabled"] = patch.enabled;
  await db
    .update(auditAlertRules)
    .set(updates)
    .where(and(tenantScope(ctx, auditAlertRules), eq(auditAlertRules.id, id)));
  const rows = await db
    .select()
    .from(auditAlertRules)
    .where(and(tenantScope(ctx, auditAlertRules), eq(auditAlertRules.id, id)))
    .limit(1);
  return rows[0] ? ruleToRow(rows[0]) : null;
}

export async function deleteAlertRule(
  ctx: TenantContext,
  id: string,
): Promise<{ removed: boolean }> {
  const result = await db
    .delete(auditAlertRules)
    .where(and(tenantScope(ctx, auditAlertRules), eq(auditAlertRules.id, id)));
  return { removed: ((result as unknown as { changes?: number }).changes ?? 0) > 0 };
}

export interface AuditAlertRow {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly triggeredCount: number;
  readonly thresholdCount: number;
  readonly windowSeconds: number;
  readonly summary: string;
  readonly createdAt: string;
}

function alertToRow(r: typeof auditAlerts.$inferSelect): AuditAlertRow {
  return {
    id: r.id,
    ruleId: r.ruleId,
    ruleName: r.ruleName,
    triggeredCount: r.triggeredCount,
    thresholdCount: r.thresholdCount,
    windowSeconds: r.windowSeconds,
    summary: r.summary,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export async function listAuditAlerts(
  ctx: TenantContext,
  input: { cursor?: string | null; limit?: number } = {},
): Promise<PaginatedData<AuditAlertRow>> {
  const limit = normaliseLimit(input.limit);
  const cursorTs =
    input.cursor && input.cursor.length > 0 ? Number(decodeCursor(input.cursor)) : null;
  const conditions = [tenantScope(ctx, auditAlerts)];
  if (cursorTs !== null && Number.isFinite(cursorTs)) {
    conditions.push(lt(auditAlerts.createdAt, cursorTs));
  }
  const rows = await db
    .select()
    .from(auditAlerts)
    .where(and(...conditions))
    .orderBy(desc(auditAlerts.createdAt))
    .limit(limit + 1);
  return buildPage(rows.map(alertToRow), limit, (r) => String(new Date(r.createdAt).getTime()));
}

interface IncomingAuditRow {
  readonly actor: string;
  readonly actionType: string | null;
}

const RULE_COOLDOWN_MS = 60_000;

/**
 * Evaluate every enabled rule against the just-appended audit row.
 *
 * To avoid hammering the DB, rules whose `actionType` predicate doesn't
 * match the incoming row are skipped (the row could not possibly have
 * pushed them across the threshold). For matching rules, count the
 * matching events inside the rolling window and emit an alert if the
 * count is at or above the threshold AND the rule has not fired in the
 * past minute (cool-down).
 */
export async function evaluateAlertRulesForEntry(
  ctx: TenantContext,
  row: IncomingAuditRow,
): Promise<void> {
  const rules = await db
    .select()
    .from(auditAlertRules)
    .where(and(tenantScope(ctx, auditAlertRules), eq(auditAlertRules.enabled, true)));
  if (rules.length === 0) return;

  // Lazy import to break the circular dependency with audit.service.
  const { countActionsInWindow } = await import("./audit.service");
  const { createNotification } = await import("./notifications.service");

  for (const rule of rules) {
    if (rule.actionType && rule.actionType !== row.actionType) continue;
    if (rule.actor && rule.actor !== row.actor) continue;
    const cooldownActive =
      rule.lastTriggeredAt !== null &&
      Date.now() - rule.lastTriggeredAt < RULE_COOLDOWN_MS;
    if (cooldownActive) continue;
    const count = await countActionsInWindow(ctx, {
      actionType: rule.actionType,
      actor: rule.actor,
      windowSeconds: rule.windowSeconds,
    });
    if (count < rule.thresholdCount) continue;
    const id = `aal_${nanoid()}`;
    const now = Date.now();
    const summary = `Rule "${rule.name}" fired: ${count} matching events in last ${rule.windowSeconds}s (threshold ${rule.thresholdCount})`;
    try {
      await db.insert(auditAlerts).values(
        withTenantValues(ctx, {
          id,
          ruleId: rule.id,
          ruleName: rule.name,
          triggeredCount: count,
          thresholdCount: rule.thresholdCount,
          windowSeconds: rule.windowSeconds,
          summary,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await db
        .update(auditAlertRules)
        .set({ lastTriggeredAt: now, updatedAt: now })
        .where(eq(auditAlertRules.id, rule.id));
      try {
        await createNotification(ctx, {
          category: "system",
          severity: "warning",
          title: `Audit alert: ${rule.name}`,
          body: summary,
        });
      } catch (e) {
        logger.warn({ err: e, ruleId: rule.id }, "audit alert notification failed");
      }
    } catch (e) {
      logger.error({ err: e, ruleId: rule.id }, "audit alert insert failed");
    }
  }
}
