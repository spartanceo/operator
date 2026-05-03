/**
 * `custom_models` — locally imported fine-tuned GGUF models (Task #47).
 *
 * Per-tenant registry of model files the user pointed Omninity Operator at
 * via the "Import custom model" flow. The file itself stays on disk under
 * the user's chosen path; we only persist metadata + a SHA-256 fingerprint
 * so the active runtime can locate and validate the file before loading it.
 *
 * Multi-tenant: scoped by `tenantId` + `workspaceId` so two users on the
 * same machine don't see each other's models.
 *
 * Per Standard 6 / Check #5: column object is flat, every reference column
 * has a matching index, mutable rows carry a `version` for optimistic
 * concurrency.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const customModels = sqliteTable(
  "custom_models",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Stable internal name used by the runtime (e.g. `legal-llama3-8b`). */
    name: text("name").notNull(),
    displayName: text("display_name").notNull().default(""),
    description: text("description").notNull().default(""),
    /** Absolute path on disk to the GGUF file. */
    filePath: text("file_path").notNull(),
    fileSize: integer("file_size").notNull().default(0),
    /** Always `gguf` for now; left as text for future formats. */
    format: text("format").notNull().default("gguf"),
    /** Detected base architecture, e.g. `llama`, `mistral`, `qwen2`. */
    architecture: text("architecture").notNull().default(""),
    /** Reported parameter count (e.g. "8B"). Free-form display string. */
    parameterCount: text("parameter_count").notNull().default(""),
    /** Quantization tag, e.g. `Q4_K_M`. */
    quantization: text("quantization").notNull().default(""),
    /** SHA-256 of the file contents at registration time. */
    sha256: text("sha256").notNull().default(""),
    /** `active` (loadable) or `disabled` (hidden from selectors). */
    status: text("status").notNull().default("active"),
    /** Optional source label — `local`, `enterprise_push`, `marketplace`. */
    source: text("source").notNull().default("local"),
    importedBy: text("imported_by").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_custom_models_tenant").on(t.tenantId),
    workspaceIdx: index("idx_custom_models_workspace").on(t.workspaceId),
    statusIdx: index("idx_custom_models_status").on(t.tenantId, t.status),
    nameUniqueIdx: uniqueIndex("uq_custom_models_workspace_name").on(
      t.workspaceId,
      t.name,
    ),
  }),
);

export type CustomModel = typeof customModels.$inferSelect;
export type NewCustomModel = typeof customModels.$inferInsert;
