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
import { migration as m0002 } from "./0002_onboarding_profiles";
import { migration as m0003 } from "./0003_model_preferences";

import type { BackgroundMigration, SchemaMigration } from "./types";

export type {
  BackgroundMigration,
  BackgroundMigrationProgress,
  BackgroundMigrationStep,
  SchemaMigration,
} from "./types";

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  m0001,
  m0002,
  m0003,
];

export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [];
