/**
 * `capability_settings` — one row per (tenant, capability_type), recording
 * which backend is currently selected for each non-LLM AI capability:
 * image-gen, web-search, tts, embeddings, code-sandbox.
 *
 * A NULL `activeBackendId` means "not configured" — the UI will prompt the
 * user to pick. This is the correct default for capabilities that may not
 * have any local service running.
 *
 * NOTE on column shape: per Check #5 columns are flat; timestamps are
 * integer milliseconds; `version` enables optimistic concurrency (Check #5).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const capabilitySettings = sqliteTable(
  "capability_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    capabilityType: text("capability_type").notNull(),
    activeBackendId: text("active_backend_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_capability_settings_tenant").on(t.tenantId),
    uniqueTypeTenantIdx: uniqueIndex("uniq_capability_settings_tenant_type").on(
      t.tenantId,
      t.capabilityType,
    ),
  }),
);

export type CapabilitySettings = typeof capabilitySettings.$inferSelect;
export type NewCapabilitySettings = typeof capabilitySettings.$inferInsert;
