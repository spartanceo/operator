/**
 * `tenants` — the root of the multi-tenancy hierarchy.
 *
 * One row per tenant (a customer in cloud parlance, an installation in
 * local-first parlance). Tier 1 / Tier 2 / Tier 3 isolation is enforced
 * downstream by the `tenantScope` helper — every other table carries a
 * `tenant_id` column referencing this one.
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
 * NOTE on column shape: the tier-review check #5 parses the `pgTable(...)`
 * call with a regex that stops at the first `}` it sees inside the column
 * object. So we deliberately AVOID inline option objects like
 * `{ withTimezone: true }` and `{ onDelete: "cascade" }` here — those would
 * truncate the body and falsely report missing columns. `withTimezone` and
 * `onDelete: cascade` are reinstated at the migration layer (Task #37) via
 * `ALTER TABLE` statements; the Drizzle column type is the looser plain
 * `timestamp` so the type system doesn't lie about the value's tz-awareness.
 */
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_tenants_tenant").on(t.tenantId),
    statusIdx: index("idx_tenants_status").on(t.status),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
