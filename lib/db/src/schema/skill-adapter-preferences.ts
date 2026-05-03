/**
 * `skill_adapter_preferences` — skill-level adapter declaration (Task #47).
 *
 * Skill creators can declare a preferred LoRA adapter in their manifest;
 * when the skill runs, OP automatically activates that adapter (if
 * installed) for the duration of the run. The mapping is stored
 * separately from the `skills` table so updating an adapter binding does
 * not perturb the skill row's `version` / `publishedAt` fields used by
 * the marketplace trust signals.
 *
 * The adapter is referenced by `adapterName` (matching `lora_adapters.name`)
 * rather than `adapterId` so a manifest stays portable across machines —
 * each member's local install resolves the name to whatever id the
 * adapter happens to have on their box.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillAdapterPreferences = sqliteTable(
  "skill_adapter_preferences",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Skill slug as it appears in `skills.slug`. */
    skillSlug: text("skill_slug").notNull(),
    /** Required base model name (so the adapter can be matched). */
    baseModel: text("base_model").notNull().default(""),
    /** Preferred adapter — resolved to a `lora_adapters.id` at run time. */
    adapterName: text("adapter_name").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_adapter_preferences_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_adapter_preferences_workspace").on(t.workspaceId),
    slugIdx: index("idx_skill_adapter_preferences_slug").on(t.workspaceId, t.skillSlug),
    pairIdx: uniqueIndex("uq_skill_adapter_preferences_pair").on(
      t.workspaceId,
      t.skillSlug,
    ),
  }),
);

export type SkillAdapterPreference = typeof skillAdapterPreferences.$inferSelect;
export type NewSkillAdapterPreference = typeof skillAdapterPreferences.$inferInsert;
