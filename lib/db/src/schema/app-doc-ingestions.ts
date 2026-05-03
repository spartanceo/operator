/**
 * `app_doc_ingestions` — background "Deep Learn" doc ingestion jobs.
 *
 * One row per (app, run). The doc ingester fetches the app's official
 * documentation, chunks + embeds it into the local vector store with
 * an `app_id` tag, and logs every URL fetched. Per-URL audit lives in
 * `privacy_events` under the "App Docs" category.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { appProfiles } from "./app-profiles";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const appDocIngestions = sqliteTable(
  "app_doc_ingestions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    appProfileId: text("app_profile_id").notNull().references(() => appProfiles.id),
    /** "queued" | "running" | "completed" | "failed" | "cancelled". */
    status: text("status").notNull().default("queued"),
    rootUrl: text("root_url").notNull(),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    pagesPlanned: integer("pages_planned").notNull().default(0),
    chunksEmbedded: integer("chunks_embedded").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_app_doc_tenant").on(t.tenantId),
    workspaceIdx: index("idx_app_doc_workspace").on(t.workspaceId),
    profileIdx: index("idx_app_doc_profile").on(t.appProfileId),
    statusIdx: index("idx_app_doc_status").on(t.tenantId, t.status),
  }),
);

export type AppDocIngestion = typeof appDocIngestions.$inferSelect;
export type NewAppDocIngestion = typeof appDocIngestions.$inferInsert;
