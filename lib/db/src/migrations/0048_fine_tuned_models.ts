/**
 * Migration 0048 — Fine-tuned models & LoRA adapter support (Task #47).
 *
 *   - `custom_models`                  — user-imported GGUF models.
 *   - `lora_adapters`                  — user-imported LoRA delta files.
 *   - `workspace_adapter_assignments`  — per-workspace adapter selection.
 *   - `enterprise_model_distributions` — IT-admin approved assets pushed
 *                                        to every seat in an org.
 *   - `skill_adapter_preferences`      — preferred adapter per skill slug.
 *
 * IF NOT EXISTS guards keep the script idempotent.
 */
import type { SchemaMigration } from "./types";

const up = `
  CREATE TABLE IF NOT EXISTS custom_models (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL DEFAULT 'gguf',
    architecture TEXT NOT NULL DEFAULT '',
    parameter_count TEXT NOT NULL DEFAULT '',
    quantization TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'local',
    imported_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_custom_models_tenant ON custom_models(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_custom_models_workspace ON custom_models(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_custom_models_status ON custom_models(tenant_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_models_workspace_name ON custom_models(workspace_id, name);

  CREATE TABLE IF NOT EXISTS lora_adapters (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    base_model TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL DEFAULT 'safetensors',
    rank INTEGER NOT NULL DEFAULT 0,
    alpha INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'local',
    imported_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_lora_adapters_tenant ON lora_adapters(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_lora_adapters_workspace ON lora_adapters(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_lora_adapters_base_model ON lora_adapters(tenant_id, base_model);
  CREATE INDEX IF NOT EXISTS idx_lora_adapters_status ON lora_adapters(tenant_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lora_adapters_workspace_name ON lora_adapters(workspace_id, name);

  CREATE TABLE IF NOT EXISTS workspace_adapter_assignments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    base_model TEXT NOT NULL,
    adapter_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_adapter_assignments_tenant ON workspace_adapter_assignments(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_adapter_assignments_workspace ON workspace_adapter_assignments(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_adapter_assignments_pair ON workspace_adapter_assignments(workspace_id, base_model);

  CREATE TABLE IF NOT EXISTS enterprise_model_distributions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    org_id TEXT NOT NULL REFERENCES enterprise_orgs(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    base_model TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    approved_by TEXT NOT NULL DEFAULT '',
    approved_at INTEGER,
    rejection_reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_enterprise_model_distributions_tenant ON enterprise_model_distributions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_model_distributions_workspace ON enterprise_model_distributions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_model_distributions_org ON enterprise_model_distributions(org_id);
  CREATE INDEX IF NOT EXISTS idx_enterprise_model_distributions_status ON enterprise_model_distributions(org_id, status);
  CREATE INDEX IF NOT EXISTS idx_enterprise_model_distributions_kind ON enterprise_model_distributions(org_id, kind);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_enterprise_model_distributions_name ON enterprise_model_distributions(org_id, kind, name);

  CREATE TABLE IF NOT EXISTS skill_adapter_preferences (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    skill_slug TEXT NOT NULL,
    base_model TEXT NOT NULL DEFAULT '',
    adapter_name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_skill_adapter_preferences_tenant ON skill_adapter_preferences(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_skill_adapter_preferences_workspace ON skill_adapter_preferences(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_skill_adapter_preferences_slug ON skill_adapter_preferences(workspace_id, skill_slug);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_adapter_preferences_pair ON skill_adapter_preferences(workspace_id, skill_slug);
`;

const down = `
  DROP TABLE IF EXISTS skill_adapter_preferences;
  DROP TABLE IF EXISTS enterprise_model_distributions;
  DROP TABLE IF EXISTS workspace_adapter_assignments;
  DROP TABLE IF EXISTS lora_adapters;
  DROP TABLE IF EXISTS custom_models;
`;

export const migration: SchemaMigration = {
  id: 48,
  name: "fine_tuned_models",
  up,
  down,
};
