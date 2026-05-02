/**
 * Background migration runner.
 *
 * Heavy data migrations — re-embedding the knowledge base, re-encoding
 * stored blobs, batch-converting old formats — must NOT block app
 * startup. They live in the `BACKGROUND_MIGRATIONS` registry and are
 * executed in chunks by this runner once the app is up.
 *
 * Lifecycle:
 *   1. `start()` reads applied data migrations from `schema_migrations`
 *      (kind = 'data'), picks the next pending one, calls `init()` to
 *      get an initial progress cursor, then schedules `step()` calls on
 *      a setTimeout loop.
 *   2. Each `step()` returns updated progress and a `done` flag. When
 *      `done` is true, the runner records a row in `schema_migrations`
 *      with kind='data' and moves on to the next migration.
 *   3. `onProgress(cb)` lets the API surface forward updates to the
 *      client (SSE or polling). Listeners receive every tick.
 *   4. `stop()` halts the loop cleanly — partial progress is NOT
 *      recorded, so the next start re-runs the in-flight chunk from
 *      its last persisted cursor (which the migration's own `init()`
 *      should derive from the database).
 *
 * The runner deliberately uses setTimeout rather than setImmediate so
 * UI work, network calls, and the GC have breathing room between
 * chunks. Default tick interval is 50 ms.
 *
 * tier-review: bounded — listener set is owner-managed and pruned on
 * unsubscribe; never grows unbounded.
 */
import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  BACKGROUND_MIGRATIONS,
  type BackgroundMigration,
  type BackgroundMigrationProgress,
} from "./migrations";

export interface BackgroundJobStatus {
  readonly running: boolean;
  readonly migration: { id: number; name: string } | null;
  readonly progress: BackgroundMigrationProgress | null;
  readonly completed: readonly number[];
  readonly error: string | null;
}

export type BackgroundProgressListener = (status: BackgroundJobStatus) => void;

export class BackgroundMigrationRunner {
  private readonly sqlite: SqliteDatabase;
  private readonly migrations: readonly BackgroundMigration[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: BackgroundMigration | null = null;
  private progress: BackgroundMigrationProgress | null = null;
  private completed: number[] = [];
  private error: string | null = null;
  // tier-review: bounded — owner-managed, drained on unsubscribe / stop.
  private readonly listeners: Set<BackgroundProgressListener> = new Set();
  private intervalMs = 50;
  private running = false;

  constructor(
    sqlite: SqliteDatabase,
    migrations: readonly BackgroundMigration[] = BACKGROUND_MIGRATIONS,
  ) {
    this.sqlite = sqlite;
    this.migrations = migrations;
  }

  status(): BackgroundJobStatus {
    return {
      running: this.running,
      migration: this.current
        ? { id: this.current.id, name: this.current.name }
        : null,
      progress: this.progress,
      completed: this.completed.slice(),
      error: this.error,
    };
  }

  onProgress(cb: BackgroundProgressListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  start(intervalMs = 50): void {
    if (this.running) return;
    this.intervalMs = intervalMs;
    this.running = true;
    this.error = null;
    this.completed = this.readCompleted();
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.current = null;
    this.progress = null;
  }

  /**
   * Drain pending migrations synchronously. Test-only helper — production
   * code uses `start()` so the event loop stays responsive.
   *
   * Reads the completed list from history first so a fresh runner
   * instance honours rows recorded by a previous run.
   */
  drainSync(): void {
    this.completed = this.readCompleted();
    while (true) {
      const next = this.pickNext();
      if (!next) return;
      this.current = next;
      this.progress = next.init(this.sqlite);
      while (true) {
        const result = next.step(this.sqlite, this.progress!);
        this.progress = result.progress;
        if (result.done) {
          this.recordComplete(next);
          this.completed.push(next.id);
          break;
        }
      }
    }
    this.current = null;
    this.progress = null;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      try {
        this.tick();
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.running = false;
        this.notify();
        return;
      }
      if (this.running) this.scheduleNext();
    }, this.intervalMs);
  }

  private tick(): void {
    if (!this.current) {
      const next = this.pickNext();
      if (!next) {
        this.running = false;
        this.notify();
        return;
      }
      this.current = next;
      this.progress = next.init(this.sqlite);
      this.notify();
      return;
    }
    const result = this.current.step(this.sqlite, this.progress!);
    this.progress = result.progress;
    if (result.done) {
      this.recordComplete(this.current);
      this.completed.push(this.current.id);
      this.current = null;
      this.progress = null;
    }
    this.notify();
  }

  private notify(): void {
    const snapshot = this.status();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch {
        // listener errors must not break the runner
      }
    }
  }

  private pickNext(): BackgroundMigration | null {
    const completed = new Set(this.completed);
    for (const m of this.migrations) {
      if (!completed.has(m.id)) return m;
    }
    return null;
  }

  private readCompleted(): number[] {
    type Row = { id: number };
    const rows = this.sqlite
      .prepare(
        `SELECT id FROM schema_migrations WHERE kind = 'data' AND status = 'applied' ORDER BY id`,
      )
      .all() as Row[];
    return rows.map((r) => r.id);
  }

  private recordComplete(migration: BackgroundMigration): void {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO schema_migrations
           (id, name, kind, checksum, applied_at, duration_ms, status)
         VALUES (?, ?, 'data', ?, ?, 0, 'applied')`,
      )
      .run(migration.id, migration.name, "background", Date.now());
  }
}
