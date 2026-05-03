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
import { migration as m0020 } from "./0020_scheduled_tasks";
import { migration as m0021 } from "./0021_skill_versioning";
import { migration as m0022 } from "./0022_skill_creator_store";
import { migration as m0023 } from "./0023_skill_reviews_trust";
import { migration as m0024 } from "./0024_p2p_distribution";
import { migration as m0025 } from "./0025_referral_growth";
import { migration as m0026 } from "./0026_developer_sdk";
import { migration as m0027 } from "./0027_integrations";
import { migration as m0028 } from "./0028_subscription_monetisation";
import { migration as m0029 } from "./0029_memory_long_term";
import { migration as m0030 } from "./0030_skill_configuration";
import { migration as m0031 } from "./0031_system_integration";
import { migration as m0032 } from "./0032_desktop_updates";
import { migration as m0033 } from "./0033_backups";
import { migration as m0034 } from "./0034_skill_execution_manifest";
import { migration as m0035 } from "./0035_mdm_enterprise";
import { migration as m0036 } from "./0036_creator_legal_tax";
import { migration as m0037 } from "./0037_privacy_dashboard";
import { migration as m0038 } from "./0038_admin_dashboard";
import { migration as m0039 } from "./0039_crash_recovery";
import { migration as m0040 } from "./0040_compliance_audit";

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
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
  m0031,
  m0032,
  m0033,
  m0034,
  m0035,
  m0036,
  m0037,
  m0038,
  m0039,
  m0040,
];

/**
 * Stable IDs for the seeded system tenant + workspace (migration 0004).
 * Re-export so service code can reference these constants without
 * hard-coding string literals at every call site.
 */
export const SYSTEM_TENANT_ID = "tenant_system";
export const SYSTEM_WORKSPACE_ID = "workspace_system";

export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [];
