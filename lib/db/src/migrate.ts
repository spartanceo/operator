/**
 * Versioned migration runner.
 *
 * Replaces the Tier-1 idempotent CREATE TABLE IF NOT EXISTS approach with
 * a real schema-version system:
 *
 *   - `schema_migrations` history table tracks every applied migration
 *     (id, name, kind, checksum, applied_at, duration_ms, status).
 *   - Each migration runs in its own transaction; a failure rolls back
 *     the partial DDL and the history row together.
 *   - Checksum drift between an applied migration and its on-disk source
 *     is treated as a hard error — silent edits to merged migrations would
 *     leave production databases out of sync with the new app version.
 *   - Optional safe-mode fallback: when called with `{ safeMode: true }`,
 *     a failure sets the global safe-mode flag and returns a result
 *     object instead of throwing, so the API server can still boot for
 *     the user to inspect their data.
 *
 * Down migrations: `rollbackTo(target)` walks applied migrations in
 * reverse and applies their `down` SQL until the schema is at `target`.
 * Used by app downgrade and the test suite.
 */
import { createHash } from "node:crypto";

import type { Database as SqliteDatabase } from "better-sqlite3";

import { getRawSqlite } from "./index";
import { SCHEMA_MIGRATIONS, type SchemaMigration } from "./migrations";
import { setSafeMode } from "./safe-mode";

/**
 * History table.
 *
 * Composite primary key `(id, kind)` so schema migrations and background
 * data migrations live in the same table without colliding when they
 * happen to share a numeric id (they do not today, but the framework
 * must not assume forever-disjoint id ranges). All reads in this file
 * filter by `kind = 'schema'`; the background runner filters by
 * `kind = 'data'`.
 */
const HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'schema',
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'applied',
    PRIMARY KEY (id, kind)
  )
`;

export interface AppliedMigrationRow {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly checksum: string;
  readonly appliedAt: number;
  readonly durationMs: number;
  readonly status: string;
}

export interface MigrationFailure {
  readonly id: number;
  readonly name: string;
  readonly error: string;
}

export interface MigrationResult {
  readonly success: boolean;
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
  readonly failure: MigrationFailure | null;
}

export interface MigrationStatus {
  readonly currentVersion: number;
  readonly latestVersion: number;
  readonly applied: readonly AppliedMigrationRow[];
  readonly pending: readonly { id: number; name: string }[];
}

export interface RunOptions {
  /**
   * When true, a migration failure sets the global safe-mode flag and
   * returns a result with `success: false` instead of throwing. The API
   * server uses this so it can still boot for the user to inspect their
   * data. Default `false` (throw on failure).
   */
  readonly safeMode?: boolean;
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
  constructor(
    message: string,
    readonly migrationId: number,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

function checksum(sql: string): string {
  // Normalise whitespace so cosmetic edits (re-indent, blank lines) don't
  // trigger a drift error. Semantically meaningful changes — different
  // column names, types, constraints — survive normalisation.
  const normalised = sql.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex");
}

/**
 * Ensure the `schema_migrations` table exists AND has the composite
 * primary key `(id, kind)`. Earlier in-flight builds of this framework
 * shipped with a single-column `PRIMARY KEY (id)` shape; databases
 * created against those builds must be upgraded in place, otherwise a
 * `kind='data'` row could clobber a `kind='schema'` row of the same id
 * via `INSERT OR REPLACE`.
 *
 * Detection uses `PRAGMA table_info`: SQLite reports a non-zero `pk`
 * column for every column participating in the primary key. A single
 * `pk=1` on `id` (and zero on `kind`) is the legacy shape; we rebuild
 * by copy + drop + rename inside one transaction.
 */
/**
 * Public alias for use by `BackgroundMigrationRunner`. Kept as a named
 * export rather than exposing `ensureHistoryTable` directly so the
 * intent ("the background runner needs to repair the table too") is
 * obvious at the callsite.
 */
export function ensureHistoryTableForBackground(sqlite: SqliteDatabase): void {
  ensureHistoryTable(sqlite);
}

function ensureHistoryTable(sqlite: SqliteDatabase): void {
  sqlite.exec(HISTORY_DDL);
  type ColInfo = { name: string; pk: number };
  const cols = sqlite
    .prepare(`PRAGMA table_info('schema_migrations')`)
    .all() as ColInfo[];
  if (cols.length === 0) return;
  const pkCols = cols
    .filter((c) => c.pk > 0)
    .map((c) => c.name)
    .sort();
  const isComposite =
    pkCols.length === 2 && pkCols[0] === "id" && pkCols[1] === "kind";
  if (isComposite) return;
  // Legacy single-column PK detected — rebuild the table.
  const repair = sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE schema_migrations__new (
        id INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'schema',
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'applied',
        PRIMARY KEY (id, kind)
      );
      INSERT INTO schema_migrations__new
        (id, name, kind, checksum, applied_at, duration_ms, status)
      SELECT id, name, kind, checksum, applied_at, duration_ms, status
      FROM schema_migrations;
      DROP TABLE schema_migrations;
      ALTER TABLE schema_migrations__new RENAME TO schema_migrations;
    `);
  });
  repair();
}

function readApplied(sqlite: SqliteDatabase): Map<number, AppliedMigrationRow> {
  type Row = {
    id: number;
    name: string;
    kind: string;
    checksum: string;
    applied_at: number;
    duration_ms: number;
    status: string;
  };
  const rows = sqlite
    .prepare(
      `SELECT id, name, kind, checksum, applied_at, duration_ms, status
       FROM schema_migrations
       WHERE status = 'applied' AND kind = 'schema'
       ORDER BY id`,
    )
    .all() as Row[];
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        kind: r.kind,
        checksum: r.checksum,
        appliedAt: r.applied_at,
        durationMs: r.duration_ms,
        status: r.status,
      },
    ]),
  );
}

function assertSequential(migrations: readonly SchemaMigration[]): void {
  for (let i = 0; i < migrations.length; i++) {
    const expected = i + 1;
    if (migrations[i]!.id !== expected) {
      throw new Error(
        `Migration registry is not sequential: position ${i} has id ${migrations[i]!.id}, expected ${expected}`,
      );
    }
  }
}

/**
 * Apply every pending schema migration. Each migration runs in its own
 * transaction; a failure rolls back the DDL and the history row together.
 *
 * With `{ safeMode: true }`, a failure sets the global safe-mode flag and
 * returns `success: false` instead of throwing — used by the API server
 * so it can still boot for inspection. Default behaviour (used by tests
 * and CLI) throws a MigrationError on failure.
 */
export function runMigrations(
  sqlite?: SqliteDatabase,
  options: RunOptions = {},
): MigrationResult {
  const handle = sqlite ?? getRawSqlite();
  assertSequential(SCHEMA_MIGRATIONS);
  ensureHistoryTable(handle);

  const applied = readApplied(handle);
  const result: {
    success: boolean;
    applied: number[];
    skipped: number[];
    failure: MigrationFailure | null;
  } = { success: true, applied: [], skipped: [], failure: null };

  for (const migration of SCHEMA_MIGRATIONS) {
    const existing = applied.get(migration.id);
    if (existing) {
      const expected = checksum(migration.up);
      if (existing.checksum !== expected) {
        const msg = `Migration ${migration.id} (${migration.name}) checksum mismatch: applied database differs from current source. This usually means a merged migration was edited — create a new migration instead.`;
        result.success = false;
        result.failure = { id: migration.id, name: migration.name, error: msg };
        if (options.safeMode) {
          setSafeMode({ reason: msg, failedMigrationId: migration.id });
          return result;
        }
        throw new MigrationError(msg, migration.id);
      }
      result.skipped.push(migration.id);
      continue;
    }

    const start = Date.now();
    const insert = handle.prepare(
      `INSERT INTO schema_migrations
         (id, name, kind, checksum, applied_at, duration_ms, status)
       VALUES (?, ?, 'schema', ?, ?, ?, 'applied')`,
    );
    const upChecksum = checksum(migration.up);
    const apply = handle.transaction(() => {
      handle.exec(migration.up);
      insert.run(
        migration.id,
        migration.name,
        upChecksum,
        Date.now(),
        Date.now() - start,
      );
    });

    try {
      apply();
      result.applied.push(migration.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failure: MigrationFailure = {
        id: migration.id,
        name: migration.name,
        error: msg,
      };
      result.success = false;
      result.failure = failure;
      if (options.safeMode) {
        setSafeMode({
          reason: `Migration ${migration.id} (${migration.name}) failed: ${msg}`,
          failedMigrationId: migration.id,
        });
        return result;
      }
      throw new MigrationError(
        `Migration ${migration.id} (${migration.name}) failed: ${msg}`,
        migration.id,
        err,
      );
    }
  }

  return result;
}

/**
 * Roll the database back to a target schema version by executing the
 * `down` SQL of every migration with `id > target` in reverse order.
 *
 * `target = 0` tears the schema down completely (used by the test suite).
 * Each rollback runs in its own transaction with the history-row delete.
 *
 * Throws `MigrationError` on failure — there is no safe-mode here because
 * rollback is an explicit operation, never invoked at startup.
 */
export function rollbackTo(target: number, sqlite?: SqliteDatabase): MigrationResult {
  const handle = sqlite ?? getRawSqlite();
  ensureHistoryTable(handle);
  if (target < 0) {
    throw new Error(`rollbackTo: target version must be >= 0, got ${target}`);
  }

  const applied = readApplied(handle);
  const toRollback = SCHEMA_MIGRATIONS.filter(
    (m) => m.id > target && applied.has(m.id),
  )
    .slice()
    .sort((a, b) => b.id - a.id);

  const result: {
    success: boolean;
    applied: number[];
    skipped: number[];
    failure: MigrationFailure | null;
  } = { success: true, applied: [], skipped: [], failure: null };

  const del = handle.prepare(
    `DELETE FROM schema_migrations WHERE id = ? AND kind = 'schema'`,
  );

  for (const migration of toRollback) {
    const apply = handle.transaction(() => {
      handle.exec(migration.down);
      del.run(migration.id);
    });
    try {
      apply();
      result.applied.push(migration.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.success = false;
      result.failure = {
        id: migration.id,
        name: migration.name,
        error: msg,
      };
      throw new MigrationError(
        `Rollback of migration ${migration.id} (${migration.name}) failed: ${msg}`,
        migration.id,
        err,
      );
    }
  }

  return result;
}

/**
 * Snapshot of migration state. Used by the admin UI and tests to show
 * what's applied and what's pending without mutating anything.
 */
export function getMigrationStatus(sqlite?: SqliteDatabase): MigrationStatus {
  const handle = sqlite ?? getRawSqlite();
  ensureHistoryTable(handle);
  const applied = readApplied(handle);
  const appliedList = [...applied.values()].sort((a, b) => a.id - b.id);
  const currentVersion = appliedList.length > 0
    ? appliedList[appliedList.length - 1]!.id
    : 0;
  const latestVersion = SCHEMA_MIGRATIONS.length > 0
    ? SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]!.id
    : 0;
  const pending = SCHEMA_MIGRATIONS
    .filter((m) => !applied.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }));
  return {
    currentVersion,
    latestVersion,
    applied: appliedList,
    pending,
  };
}
