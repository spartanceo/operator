/**
 * `acquisition_channels` — singleton-per-tenant "How did you hear about
 * OP?" answer captured during onboarding. Drives top-of-funnel attribution
 * for the growth team without any third-party analytics SDK.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const acquisitionChannels = sqliteTable(
  "acquisition_channels",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    channel: text("channel").notNull(),
    detail: text("detail"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_acquisition_channels_tenant").on(t.tenantId),
    channelIdx: index("idx_acquisition_channels_channel").on(t.channel),
  }),
);

export type AcquisitionChannel = typeof acquisitionChannels.$inferSelect;
export type NewAcquisitionChannel = typeof acquisitionChannels.$inferInsert;
