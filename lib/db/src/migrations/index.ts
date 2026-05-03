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
import { migration as m0010 } from "./0010_notifications_activity";
import { migration as m0011 } from "./0011_mobile_companion";
import { migration as m0012 } from "./0012_telemetry";
import { migration as m0013 } from "./0013_legal_compliance";
import { migration as m0014 } from "./0014_conversations";
import { migration as m0015 } from "./0015_undo_actions";
import { migration as m0016 } from "./0016_workspace_grouping";
import { migration as m0017 } from "./0017_skills";
import { migration as m0018 } from "./0018_task_queue";
import { migration as m0019 } from "./0019_task_templates";

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
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
];

/**
 * Stable IDs for the seeded system tenant + workspace (migration 0004).
 * Re-export so service code can reference these constants without
 * hard-coding string literals at every call site.
 */
export const SYSTEM_TENANT_ID = "tenant_system";
export const SYSTEM_WORKSPACE_ID = "workspace_system";

export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [];
