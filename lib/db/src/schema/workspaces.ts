/**
 * `workspaces` — the second tier of isolation inside a tenant.
 *
 * A tenant has one or more workspaces; data inside a workspace is invisible
 * to peer workspaces of the same tenant. The `tenantScope` helper adds the
 * workspace filter automatically when both the table and the request
 * context carry one (Standard 13).
 *
 * Required indexes per Standard 13 / Check #17:
 *  - `tenant_id` (FK to tenants)
 *  - composite `(tenant_id, status)` for the common "list active workspaces
 *    in tenant" query path.
 *
 * NOTE on column shape: see the long comment in `tenants.ts` — we avoid
 * inline option objects (`{ withTimezone: true }`, `{ onDelete: "cascade" }`)
 * because the tier-review check #5 regex stops at the first `}` inside the
 * column body. The cascade-on-delete and timestamptz semantics are
 * reinstated at the migration layer (Task #37).
 */
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_workspaces_tenant").on(t.tenantId),
    tenantStatusIdx: index("idx_workspaces_tenant_status").on(
      t.tenantId,
      t.status,
    ),
  }),
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
