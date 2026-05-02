/**
 * `calendar_events` — local mirror of calendar entries.
 *
 * Events are fetched from Google / Apple Calendar via OAuth and cached here
 * so OP can read the schedule, find free slots, and reschedule without
 * round-tripping the provider on every read. Writes go to the provider via
 * the calendar service which then upserts the local row with the
 * provider-assigned id.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { commAccounts } from "./comm-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    accountId: text("account_id").notNull().references(() => commAccounts.id),
    /** Provider event id (Google Calendar `eventId`, Apple ICS UID). */
    providerEventId: text("provider_event_id"),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    /** JSON: `[{ email, name, response }]`. */
    attendeesJson: text("attendees_json"),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    /** "confirmed" | "tentative" | "cancelled". */
    status: text("status").notNull().default("confirmed"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_calendar_events_tenant").on(t.tenantId),
    workspaceIdx: index("idx_calendar_events_workspace").on(t.workspaceId),
    accountIdx: index("idx_calendar_events_account").on(t.accountId),
    startsIdx: index("idx_calendar_events_starts").on(t.tenantId, t.startsAt),
    statusIdx: index("idx_calendar_events_status").on(t.tenantId, t.status),
  }),
);

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;
