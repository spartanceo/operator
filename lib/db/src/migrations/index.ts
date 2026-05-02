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
import { migration as m0004 } from "./0004_system_tenant";
import { migration as m0005 } from "./0005_desktop_control";
import { migration as m0006 } from "./0006_knowledge_base";
import { migration as m0007 } from "./0007_media_assets";
import { migration as m0008 } from "./0008_communication_hub";
import { migration as m0009 } from "./0009_security_hardening";

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
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
];

/**
 * Stable IDs for the seeded system tenant + workspace (migration 0004).
 * Re-export so service code can reference these constants without
 * hard-coding string literals at every call site.
 */
export const SYSTEM_TENANT_ID = "tenant_system";
export const SYSTEM_WORKSPACE_ID = "workspace_system";

export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [];
