/**
 * `comm_accounts` — connected communication accounts (Gmail, Outlook, Google
 * Calendar, Apple Calendar, Twilio VoIP).
 *
 * Credentials live locally only — `accessToken`, `refreshToken`, and any
 * provider-specific secret are written here and never leave the box. A
 * future hardening pass swaps the column type for an OS-keychain pointer
 * (Standard 12 §"Credential & secret handling"); the column shape stays
 * the same so call sites don't churn.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const commAccounts = sqliteTable(
  "comm_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** "gmail" | "outlook" | "google_calendar" | "apple_calendar" | "twilio". */
    provider: text("provider").notNull(),
    /** "email" | "calendar" | "voip" — the high-level capability. */
    kind: text("kind").notNull(),
    /** Display label shown in the UI: usually the email or phone number. */
    label: text("label").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: integer("token_expires_at"),
    /** "active" | "disconnected" | "error". */
    status: text("status").notNull().default("active"),
    /** Free-form JSON blob for provider-specific config (phone number, SID). */
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_comm_accounts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_comm_accounts_workspace").on(t.workspaceId),
    providerIdx: index("idx_comm_accounts_provider").on(t.tenantId, t.provider),
    statusIdx: index("idx_comm_accounts_status").on(t.tenantId, t.status),
  }),
);

export type CommAccount = typeof commAccounts.$inferSelect;
export type NewCommAccount = typeof commAccounts.$inferInsert;
