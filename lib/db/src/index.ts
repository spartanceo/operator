/**
 * `@workspace/db` — the only place `db` is constructed.
 *
 * Local-first SQLite store backed by better-sqlite3. The connection is opened
 * lazily on first access so test harnesses can override `SQLITE_PATH` (e.g.
 * to `:memory:`) before the module's first dereference.
 *
 * Exports:
 *   - `db`              — the Drizzle client (lazy proxy).
 *   - `getRawSqlite()`  — underlying better-sqlite3 handle (migrations, pragmas).
 *   - `tenantScope`     — Standard 13 canonical scoping helper.
 *   - `withTenant`      — alias for tenantScope.
 *   - `paginated` /
 *     `buildPage` /
 *     `encodeCursor` /
 *     `decodeCursor` /
 *     `normaliseLimit`  — Standard 13 canonical pagination helpers.
 *   - `LRUCache`        — Standard 13 sanctioned bounded-cache primitive.
 *   - schema tables     — re-exported from ./schema.
 *
 * Service and route files MUST import the helper(s) they need from this
 * package alongside `db` — Check #15 fails if `db` is imported without
 * `tenantScope` or `withTenant`.
 */
import path from "node:path";
import fs from "node:fs";

import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

type Schema = typeof schema;

let _sqlite: SqliteDatabase | null = null;
let _drizzle: BetterSQLite3Database<Schema> | null = null;

function resolveDbFile(): string {
  const fromEnv = process.env["SQLITE_PATH"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const dataDir = path.resolve(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, "omninity.db");
}

function init(): { sqlite: SqliteDatabase; drizzleDb: BetterSQLite3Database<Schema> } {
  if (_sqlite && _drizzle) return { sqlite: _sqlite, drizzleDb: _drizzle };
  const file = resolveDbFile();
  const sqlite = new Database(file);
  // Local-first: WAL is the right journal mode for low-latency single-writer
  // workloads. foreign_keys is OFF by default in SQLite — we always want it on.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  const drizzleDb = drizzle(sqlite, { schema });
  _sqlite = sqlite;
  _drizzle = drizzleDb;
  return { sqlite, drizzleDb };
}

/**
 * Returns the underlying better-sqlite3 handle. Used only by the migration
 * runner and shutdown path — application code must go through `db`.
 */
export function getRawSqlite(): SqliteDatabase {
  return init().sqlite;
}

/**
 * Close the active SQLite connection (if any). Used by tests that swap
 * databases between cases so the next `db` access opens a fresh handle.
 */
export function closeDb(): void {
  if (_sqlite) {
    try {
      _sqlite.close();
    } catch {
      // already closed
    }
    _sqlite = null;
    _drizzle = null;
  }
}

// `db` is a Proxy so the lazy init runs on first method call rather than at
// module load. This is the seam test harnesses rely on: they set
// `SQLITE_PATH=:memory:` BEFORE the first `db.select()` call and we honour it.
export const db: BetterSQLite3Database<Schema> = new Proxy({} as BetterSQLite3Database<Schema>, {
  get(_target, prop) {
    const { drizzleDb } = init();
    const value = (drizzleDb as unknown as Record<string | symbol, unknown>)[prop as string];
    if (typeof value === "function") {
      return (value as (...a: unknown[]) => unknown).bind(drizzleDb);
    }
    return value;
  },
});

export * from "./schema";
export * from "./helpers";
export { runMigrations } from "./migrate";
export type { PaginatedData, PaginatedEnvelope } from "@workspace/types";
