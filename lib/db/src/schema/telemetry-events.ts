/**
 * `telemetry_events` — append-only opt-in usage / performance / onboarding
 * / marketplace events.
 *
 * The privacy enforcement layer in `telemetry.service.ts` is the gate that
 * rejects events when the per-category consent is off and that strips PII
 * from the payload before it ever reaches this table. The schema therefore
 * only stores a JSON `payload` blob plus the categorisation columns the
 * dashboard aggregates over.
 *
 * Append-only: no `version` column required — the tier-review Check #5
 * exempts tables whose name contains "event".
 *
 * `anonymous_id` is a per-tenant random identifier (the column lives on
 * `telemetry_settings`) and is the ONLY actor identifier copied here. The
 * tenantId column exists for tenant-scoped reads (so each install can see
 * its own audit trail and request erasure) but the OP team dashboard
 * aggregates by `anonymous_id` so individual tenants are not re-identified.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const telemetryEvents = sqliteTable(
  "telemetry_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    anonymousId: text("anonymous_id").notNull(),
    category: text("category").notNull(),
    eventName: text("event_name").notNull(),
    payload: text("payload").notNull(),
    opVersion: text("op_version").notNull().default("0.1.0"),
    osPlatform: text("os_platform"),
    hardwareTier: text("hardware_tier"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_telemetry_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_telemetry_events_workspace").on(t.workspaceId),
    categoryIdx: index("idx_telemetry_events_category").on(t.tenantId, t.category),
    nameIdx: index("idx_telemetry_events_name").on(t.tenantId, t.eventName),
    createdIdx: index("idx_telemetry_events_created").on(t.tenantId, t.createdAt),
    anonIdx: index("idx_telemetry_events_anon").on(t.anonymousId, t.createdAt),
  }),
);

export type TelemetryEventRow = typeof telemetryEvents.$inferSelect;
export type NewTelemetryEventRow = typeof telemetryEvents.$inferInsert;
