/**
 * `runtime_settings` — one row per tenant, recording which model runtime
 * (Ollama, LM Studio, Jan, llamafile, OpenAI, Anthropic) is currently the
 * active inference target.
 *
 * Why a settings table instead of an env var: per Standard 13 each tenant
 * gets to pick their own runtime; one flat env knob would not scope. The
 * row is mutable so it carries a `version` column for optimistic concurrency
 * (Check #5 requirement).
 *
 * NOTE on column shape: per Check #5, the column object must contain only
 * inline column definitions — no nested option objects. Timestamps are
 * stored as integer milliseconds, same as every other table.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const runtimeSettings = sqliteTable(
  "runtime_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    activeRuntimeId: text("active_runtime_id").notNull().default("ollama"),
    defaultModel: text("default_model"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_runtime_settings_tenant").on(t.tenantId),
  }),
);

export type RuntimeSettings = typeof runtimeSettings.$inferSelect;
export type NewRuntimeSettings = typeof runtimeSettings.$inferInsert;
