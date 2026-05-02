/**
 * Migration framework type definitions.
 *
 * Two flavours:
 *   - SchemaMigration  — DDL applied synchronously at app startup, wrapped
 *                        in a transaction. Must be fast and small.
 *   - BackgroundMigration — heavy data work (re-embedding, format changes)
 *                        executed in chunks by `BackgroundMigrationRunner`
 *                        AFTER the app has booted, with progress reporting.
 *
 * Every migration carries a unique numeric `id` (the schema version it
 * brings the database to). IDs MUST be sequential and assigned at creation
 * time — never renumber a merged migration.
 */
import type { Database as SqliteDatabase } from "better-sqlite3";

export interface SchemaMigration {
  readonly id: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

export interface BackgroundMigrationProgress {
  readonly processed: number;
  readonly total: number;
  readonly cursor: string | null;
}

export interface BackgroundMigrationStep {
  readonly progress: BackgroundMigrationProgress;
  readonly done: boolean;
}

export interface BackgroundMigration {
  readonly id: number;
  readonly name: string;
  readonly init: (sqlite: SqliteDatabase) => BackgroundMigrationProgress;
  readonly step: (
    sqlite: SqliteDatabase,
    progress: BackgroundMigrationProgress,
  ) => BackgroundMigrationStep;
}
