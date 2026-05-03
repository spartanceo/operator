/**
 * `creator_milestones` — append-only achievement events fired when a
 * skill crosses an install threshold ("Your skill just hit 1,000 installs").
 *
 * Each row is a shareable card. Append-only audit-class — no `version`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";

export const creatorMilestones = sqliteTable(
  "creator_milestones",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    skillId: text("skill_id").notNull(),
    skillName: text("skill_name").notNull(),
    milestone: text("milestone").notNull(),
    threshold: integer("threshold").notNull(),
    dismissed: integer("dismissed").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_creator_milestones_tenant").on(t.tenantId),
    skillIdx: index("idx_creator_milestones_skill").on(t.tenantId, t.skillId),
    uniqueIdx: uniqueIndex("idx_creator_milestones_unique").on(
      t.tenantId,
      t.skillId,
      t.threshold,
    ),
  }),
);

export type CreatorMilestone = typeof creatorMilestones.$inferSelect;
export type NewCreatorMilestone = typeof creatorMilestones.$inferInsert;
