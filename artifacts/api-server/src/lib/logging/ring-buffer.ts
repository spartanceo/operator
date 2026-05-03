/**
 * Bounded in-memory ring buffer of recent log records.
 *
 * Used by the in-app diagnostics viewer (Settings → Diagnostics) so power
 * users can browse recent logs without reading rotated files. The buffer is
 * sanitised — every record passes through the sanitiser before it lands —
 * and is capped at `capacity` records (default 1000) to keep memory bounded.
 */
export interface LogRecord {
  ts: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  module: string;
  msg: string;
  traceId?: string;
  tenantId?: string;
  meta?: Record<string, unknown>;
}

export interface RingFilter {
  level?: LogRecord["level"];
  modules?: string[];
  since?: string;
  limit?: number;
}

const LEVEL_RANK: Record<LogRecord["level"], number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export class LogRingBuffer {
  private readonly capacity: number;
  private buf: LogRecord[];
  private head = 0;
  private size = 0;

  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.buf = new Array<LogRecord>(capacity);
  }

  push(rec: LogRecord): void {
    this.buf[this.head] = rec;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  query(filter: RingFilter = {}): LogRecord[] {
    const minRank = filter.level ? LEVEL_RANK[filter.level] : 0;
    const sinceMs = filter.since ? Date.parse(filter.since) : 0;
    const moduleSet =
      filter.modules && filter.modules.length > 0
        ? new Set(filter.modules)
        : null;

    const out: LogRecord[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx =
        (this.head - 1 - i + this.capacity * 2) % this.capacity;
      const rec = this.buf[idx];
      if (!rec) continue;
      if (LEVEL_RANK[rec.level] < minRank) continue;
      if (moduleSet && !moduleSet.has(rec.module)) continue;
      if (sinceMs && Date.parse(rec.ts) < sinceMs) continue;
      out.push(rec);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  clear(): void {
    this.buf = new Array<LogRecord>(this.capacity);
    this.head = 0;
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }
}

export const recentLogs = new LogRingBuffer(1000);
