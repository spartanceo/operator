/**
 * `lora_adapters` — imported LoRA / Low-Rank Adaptation files (Task #47).
 *
 * A LoRA adapter is a small (50–500 MB) delta applied on top of a base
 * model at inference time. We register the file path + the *base model
 * name* the adapter was trained against so the runtime can refuse to load
 * an incompatible pair.
 *
 * `baseModel` is a free-form model identifier — it can match either a
 * built-in Ollama model name (`llama3.1:8b`) or a `custom_models.name`
 * value. The compatibility check at registration time only enforces that
 * the base model is *known* to this tenant; runtime mismatches still
 * surface a clear error from the adapter loader.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const loraAdapters = sqliteTable(
  "lora_adapters",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    displayName: text("display_name").notNull().default(""),
    description: text("description").notNull().default(""),
    /** Base model identifier this adapter was trained against. */
    baseModel: text("base_model").notNull(),
    filePath: text("file_path").notNull(),
    fileSize: integer("file_size").notNull().default(0),
    /** `bin` or `safetensors`. */
    format: text("format").notNull().default("safetensors"),
    /** LoRA rank — informational, surfaced in the management UI. */
    rank: integer("rank").notNull().default(0),
    /** LoRA alpha — informational. */
    alpha: integer("alpha").notNull().default(0),
    sha256: text("sha256").notNull().default(""),
    /** `active` or `disabled`. */
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("local"),
    importedBy: text("imported_by").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_lora_adapters_tenant").on(t.tenantId),
    workspaceIdx: index("idx_lora_adapters_workspace").on(t.workspaceId),
    baseModelIdx: index("idx_lora_adapters_base_model").on(t.tenantId, t.baseModel),
    statusIdx: index("idx_lora_adapters_status").on(t.tenantId, t.status),
    nameUniqueIdx: uniqueIndex("uq_lora_adapters_workspace_name").on(
      t.workspaceId,
      t.name,
    ),
  }),
);

export type LoraAdapter = typeof loraAdapters.$inferSelect;
export type NewLoraAdapter = typeof loraAdapters.$inferInsert;
