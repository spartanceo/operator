/**
 * In-process pub/sub for skill progress events (Task #39).
 *
 * Skills call `context.report(fraction, message)` from inside the sandbox;
 * the executor forwards each event here. The chat UI subscribes via the
 * SSE endpoint `GET /api/skills/runs/:invocationId/progress` to render
 * live updates ("Processing invoice 3 of 12…").
 *
 * Bounded ring buffer per invocation so a chatty skill cannot exhaust
 * memory. New subscribers receive the buffer as a backlog before tailing
 * live events.
 */
import type { SkillProgressEvent } from "@workspace/types";

const MAX_BUFFER = 200;
const MAX_STREAMS = 10_000;

interface InvocationStream {
  readonly buffer: SkillProgressEvent[];
  readonly listeners: Set<(event: SkillProgressEvent) => void>;
  ended: boolean;
}

/**
 * Keys are tenant-prefixed (`<tenantId>::<invocationId>`) so an
 * invocation id leaking across tenants cannot expose another tenant's
 * progress events. The map is hard-capped at MAX_STREAMS via FIFO
 * eviction; combined with the per-stream MAX_BUFFER ring this gives a
 * bounded module-level cache (tier-review safety check).
 */
// tier-review: bounded — capped at MAX_STREAMS via FIFO eviction below.
const streams = new Map<string, InvocationStream>();

function streamKey(tenantId: string, invocationId: string): string {
  return `${tenantId}::${invocationId}`;
}

function getOrCreate(tenantId: string, invocationId: string): InvocationStream {
  const key = streamKey(tenantId, invocationId);
  let s = streams.get(key);
  if (!s) {
    if (streams.size >= MAX_STREAMS) {
      const oldest = streams.keys().next().value;
      if (oldest !== undefined) streams.delete(oldest);
    }
    s = { buffer: [], listeners: new Set(), ended: false };
    streams.set(key, s);
  }
  return s;
}

export function publishProgress(
  tenantId: string,
  event: SkillProgressEvent,
): void {
  const s = getOrCreate(tenantId, event.invocationId);
  if (s.ended) return;
  s.buffer.push(event);
  if (s.buffer.length > MAX_BUFFER) s.buffer.shift();
  for (const fn of s.listeners) {
    try {
      fn(event);
    } catch {
      // Listener errors must not affect the publisher.
    }
  }
}

export function endProgress(tenantId: string, invocationId: string): void {
  const key = streamKey(tenantId, invocationId);
  const s = streams.get(key);
  if (!s) return;
  s.ended = true;
  for (const fn of s.listeners) {
    try {
      fn({
        invocationId,
        skillId: "",
        fraction: 1,
        message: "__end__",
        at: new Date().toISOString(),
      });
    } catch {
      /* swallow */
    }
  }
  s.listeners.clear();
  // Defer drop so a slow subscriber can still read the backlog.
  setTimeout(() => streams.delete(key), 60_000).unref();
}

export function getBacklog(
  tenantId: string,
  invocationId: string,
): ReadonlyArray<SkillProgressEvent> {
  return streams.get(streamKey(tenantId, invocationId))?.buffer.slice() ?? [];
}

export function subscribeProgress(
  tenantId: string,
  invocationId: string,
  fn: (event: SkillProgressEvent) => void,
): () => void {
  const s = getOrCreate(tenantId, invocationId);
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

/** Test-only — drop all in-flight streams. */
export function __resetProgressBus(): void {
  streams.clear();
}
