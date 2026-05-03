/**
 * `dmca_takedowns` — public DMCA takedown notices submitted via the
 * marketing-site form. Mutable `status` column drives the admin
 * workflow (received → reviewing → upheld / rejected / counter_noticed
 * → restored). Status transitions are mirrored to `activity_events`
 * so the original row remains the canonical record.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const dmcaTakedowns = sqliteTable(
  "dmca_takedowns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    storeSkillId: text("store_skill_id"),
    creatorHandle: text("creator_handle"),
    skillSlug: text("skill_slug"),
    skillUrl: text("skill_url"),
    claimantName: text("claimant_name").notNull(),
    claimantEmail: text("claimant_email").notNull(),
    claimantAddress: text("claimant_address").notNull(),
    claimantPhone: text("claimant_phone"),
    workDescription: text("work_description").notNull(),
    infringementDescription: text("infringement_description").notNull(),
    goodFaithStatement: integer("good_faith_statement").notNull().default(0),
    accuracyStatement: integer("accuracy_statement").notNull().default(0),
    signature: text("signature").notNull(),
    status: text("status").notNull().default("received"),
    decisionNotes: text("decision_notes"),
    decidedAt: integer("decided_at"),
    decidedBy: text("decided_by"),
    skillRemovedAt: integer("skill_removed_at"),
    counterNoticeId: text("counter_notice_id"),
    submitterIp: text("submitter_ip"),
    submitterUserAgent: text("submitter_user_agent"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_dmca_takedowns_tenant").on(t.tenantId),
    workspaceIdx: index("idx_dmca_takedowns_workspace").on(t.workspaceId),
    statusIdx: index("idx_dmca_takedowns_status").on(t.status),
    targetIdx: index("idx_dmca_takedowns_target").on(t.creatorHandle, t.skillSlug),
    createdIdx: index("idx_dmca_takedowns_created").on(t.createdAt),
    storeSkillIdx: index("idx_dmca_takedowns_store_skill").on(t.storeSkillId),
  }),
);

export type DmcaTakedown = typeof dmcaTakedowns.$inferSelect;
export type NewDmcaTakedown = typeof dmcaTakedowns.$inferInsert;
