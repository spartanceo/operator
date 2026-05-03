/**
 * Migration 0017 — task templates & categories (Task #46).
 *
 * Adds two tables that back the reusable-workflow system:
 *
 *   - `task_template_categories` — user-defined folders ("Work",
 *     "Personal", "Clients").
 *   - `task_templates` — reusable, parameterised prompts. Captures the
 *     prompt text, declared variables, the agent/skill configuration
 *     snapshot, optional pin order for quick-launch, and usage stats.
 *
 * `category_id` on `task_templates` is nullable — categories are entirely
 * optional. The "max 5 pinned per workspace" cap is enforced in
 * `task-templates.service.ts`, not at the DB layer, because the cap can
 * grow without a schema change as the UI evolves.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS task_template_categories (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    color TEXT,
    icon TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_task_template_categories_tenant
    ON task_template_categories(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_task_template_categories_workspace
    ON task_template_categories(tenant_id, workspace_id);

  CREATE TABLE IF NOT EXISTS task_templates (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    category_id TEXT REFERENCES task_template_categories(id),
    name TEXT NOT NULL,
    description TEXT,
    prompt TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '[]',
    skill_config TEXT NOT NULL DEFAULT '{}',
    pinned_order INTEGER,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    source_run_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_task_templates_tenant
    ON task_templates(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_task_templates_workspace
    ON task_templates(tenant_id, workspace_id);
  CREATE INDEX IF NOT EXISTS idx_task_templates_category
    ON task_templates(tenant_id, category_id);
  CREATE INDEX IF NOT EXISTS idx_task_templates_pinned
    ON task_templates(tenant_id, workspace_id, pinned_order);
  CREATE INDEX IF NOT EXISTS idx_task_templates_last_used
    ON task_templates(tenant_id, last_used_at);
`;

const down = `
  DROP TABLE IF EXISTS task_templates;
  DROP TABLE IF EXISTS task_template_categories;
`;

export const migration: SchemaMigration = {
  id: 19,
  name: "task_templates",
  up,
  down,
};
