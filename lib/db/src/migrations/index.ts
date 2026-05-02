/**
 * Migration registry.
 *
 * SCHEMA_MIGRATIONS — sequential DDL migrations applied at startup.
 * BACKGROUND_MIGRATIONS — long-running data migrations executed by
 * `BackgroundMigrationRunner` after the app has booted.
 *
 * Ordering invariant: both arrays MUST be sorted by `id` ascending. The
 * `runMigrations` runner asserts strict monotonicity from 1 with no gaps.
 *
 * To add a migration: create `NNNN_name.ts`, import it here, append to the
 * relevant array. Never reorder or renumber existing entries.
 */
import { migration as m0001 } from "./0001_baseline";

import type { BackgroundMigration, SchemaMigration } from "./types";

export type {
  BackgroundMigration,
  BackgroundMigrationProgress,
  BackgroundMigrationStep,
  SchemaMigration,
} from "./types";

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [m0001];

export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [];
