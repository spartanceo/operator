/**
 * `tenants` — root of the multi-tenancy hierarchy.
 *
 * One row per local installation. Tier 1 / Tier 2 / Tier 3 isolation is
 * enforced downstream by the `tenantScope` helper — every other table carries
 * a `tenant_id` column referencing this one.
 *
 * Why this table itself carries a self-referencing `tenant_id`:
 *   The `tenantScope` helper takes any table that exposes a `tenantId`
 *   column; modelling the tenants row as its own tenant lets the same
 *   helper work uniformly (no special case for the root table). The value
 *   is always equal to `id` and is enforced by the insert path.
 *
 * Required columns (Standard 13 / Check #5):
 *   id, tenantId, createdAt, updatedAt, version
 *
 * NOTE on column shape: the tier-review check #5 parses the `sqliteTable(...)`
 * call with a regex that stops at the first `}` it sees inside the column
 * object. So we deliberately AVOID inline option objects like
 * `{ mode: "timestamp" }` — those would truncate the body and falsely
 * report missing columns. Timestamps are stored as integer milliseconds.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_tenants_tenant").on(t.tenantId),
    statusIdx: index("idx_tenants_status").on(t.status),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
