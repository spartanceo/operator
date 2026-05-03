/**
 * In-process event bus for the Developer SDK & Plugin API (Task #14).
 *
 * Anything inside the API server can call `emitOpEvent(ctx, type, data)`
 * to publish a developer-facing event. The bus does two things:
 *
 *   1. Keeps a bounded ring of recent events per tenant so the SDK and
 *      `op` CLI can poll `/api/events/recent` for live activity even
 *      without a webhook listener configured.
 *
 *   2. Hands the event to `dispatchToWebhooks()` so every enabled
 *      subscription whose `eventTypes` filter matches receives an HTTP
 *      POST. Delivery is fire-and-forget — the bus never blocks the
 *      caller and never throws.
 *
 * Standard 13: every persistent collection is bounded. The recent-event
 * ring caps at MAX_RECENT_PER_TENANT entries with FIFO eviction.
 */
import type { TenantContext } from "@workspace/types";

import { logger } from "./logger";

export type OpEventType =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "tool_called"
  | "approval_requested"
  | "approval_resolved"
  | "skill_installed"
  | "skill_uninstalled"
  | "skill_invoked"
  | "plugin_tool_registered"
  | "plugin_tool_invoked";

export interface OpEvent {
  readonly id: string;
  readonly type: OpEventType;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

const MAX_RECENT_PER_TENANT = 100;
const MAX_TENANTS = 1024;
// tier-review: bounded — capped at MAX_TENANTS keys (FIFO), each bucket capped at MAX_RECENT_PER_TENANT.
const recent = new Map<string, OpEvent[]>();

let dispatcher: ((event: OpEvent) => Promise<void> | void) | null = null;

/**
 * Wire the webhook dispatcher. Called once from
 * `webhook-subscriptions.service.ts` so the bus stays free of a
 * direct dependency on the service layer.
 */
export function registerEventDispatcher(
  fn: (event: OpEvent) => Promise<void> | void,
): void {
  dispatcher = fn;
}

/** Test-only — clear the recent ring between cases. */
export function clearEventBusForTests(): void {
  recent.clear();
}

function pushRecent(event: OpEvent): void {
  const key = `${event.tenantId}:${event.workspaceId}`;
  let bucket = recent.get(key);
  if (!bucket) {
    if (recent.size >= MAX_TENANTS) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
    bucket = [];
    recent.set(key, bucket);
  }
  bucket.push(event);
  while (bucket.length > MAX_RECENT_PER_TENANT) bucket.shift();
}

let counter = 0;
function nextId(): string {
  counter = (counter + 1) % 1_000_000;
  return `evt_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * Publish an event. Never throws — webhook errors are swallowed and
 * logged so the request that triggered the event is unaffected.
 */
export function emitOpEvent(
  ctx: TenantContext,
  type: OpEventType,
  data: Record<string, unknown> = {},
): OpEvent {
  const event: OpEvent = {
    id: nextId(),
    type,
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId ?? ctx.tenantId,
    timestamp: new Date().toISOString(),
    data,
  };
  pushRecent(event);
  if (dispatcher) {
    Promise.resolve()
      .then(() => dispatcher!(event))
      .catch((err) => logger.warn({ err, eventId: event.id }, "Webhook dispatch failed"));
  }
  return event;
}

export interface RecentEventsOptions {
  readonly limit?: number;
  readonly afterId?: string;
  readonly type?: OpEventType;
}

export function getRecentEvents(
  ctx: TenantContext,
  opts: RecentEventsOptions = {},
): ReadonlyArray<OpEvent> {
  const key = `${ctx.tenantId}:${ctx.workspaceId}`;
  const bucket = recent.get(key) ?? [];
  let view = bucket as ReadonlyArray<OpEvent>;
  if (opts.afterId) {
    const idx = view.findIndex((e) => e.id === opts.afterId);
    if (idx >= 0) view = view.slice(idx + 1);
  }
  if (opts.type) view = view.filter((e) => e.type === opts.type);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_RECENT_PER_TENANT);
  return view.slice(-limit);
}
