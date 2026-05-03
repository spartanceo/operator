/**
 * `skill_configurations` — per-workspace user-supplied configuration for
 * an installed skill (Task #43).
 *
 * Skills declare a configuration schema in their manifest (API keys,
 * folder paths, preferences). Users fill that out post-install via the
 * auto-generated configuration panel; the values land here.
 *
 * Sensitive fields (`password`, `apiKey`) never sit in this table — the
 * service writes those to `secret_vault_entries` (OS keychain wrapper)
 * and only the field key is referenced from `secretRefs`.
 *
 * One row per (tenant, workspace, skill). `withTenantValues` already
 * stamps tenant_id + workspace_id so the unique index also enforces the
 * "one config per workspace per skill" invariant.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { skills } from "./skills";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillConfigurations = sqliteTable(
  "skill_configurations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    skillId: text("skill_id").notNull().references(() => skills.id),
    /** JSON object — non-sensitive field values keyed by config field key. */
    valuesJson: text("values_json").notNull().default("{}"),
    /** JSON string array — keys whose values live in the keychain vault. */
    secretRefsJson: text("secret_refs_json").notNull().default("[]"),
    /** Set when the user first satisfied every required field. */
    configuredAt: integer("configured_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_configurations_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_configurations_workspace").on(
      t.tenantId,
      t.workspaceId,
    ),
    skillIdx: index("idx_skill_configurations_skill").on(t.tenantId, t.skillId),
    uniqPerWorkspace: uniqueIndex("idx_skill_configurations_unique").on(
      t.tenantId,
      t.workspaceId,
      t.skillId,
    ),
  }),
);

export type SkillConfiguration = typeof skillConfigurations.$inferSelect;
export type NewSkillConfiguration = typeof skillConfigurations.$inferInsert;
