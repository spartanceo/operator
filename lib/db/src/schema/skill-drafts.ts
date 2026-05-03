/**
 * `skill_drafts` — in-progress no-code skill creator wizard sessions.
 *
 * A draft is the user-facing scratchpad before a skill is finalised: it
 * holds the raw input the user supplied (uploaded file text, pasted text,
 * or interview transcript), the structured fields the local model
 * proposed, and any tester runs the user has executed against it.
 *
 * `source` records which entry path was used: "upload" | "paste" |
 * "interview". `status` walks `draft → ready → published` as the user
 * progresses through preview, tester, and (optional) store submission.
 *
 * Multi-tenant: every row scoped by `tenantId` + `workspaceId`. Drafts
 * never leave the local tenant — the only egress is the explicit publish
 * action which writes a `store_skills` row in the same database.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillDrafts = sqliteTable(
  "skill_drafts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** "upload" | "paste" | "interview" */
    source: text("source").notNull(),
    /** "draft" | "ready" | "published" */
    status: text("status").notNull().default("draft"),
    /** Raw input the user supplied (extracted file text, pasted text, or "" for interview). */
    rawInput: text("raw_input").notNull().default(""),
    /** JSON-encoded array of {role:'system'|'user'|'assistant',content:string} for interview mode. */
    interviewTranscript: text("interview_transcript").notNull().default("[]"),
    /** Index of the next interview question to ask (0..6). 7+ means interview is finished. */
    interviewStep: integer("interview_step").notNull().default(0),
    /** Proposed/edited skill name. */
    name: text("name").notNull().default(""),
    /** Proposed/edited skill description. */
    description: text("description").notNull().default(""),
    /** Proposed/edited skill prompt template (the body content the agent reads). */
    content: text("content").notNull().default(""),
    /** JSON-encoded array of compatible model names. */
    modelTags: text("model_tags").notNull().default("[]"),
    /** JSON-encoded array of trigger phrases. */
    triggers: text("triggers").notNull().default("[]"),
    /** JSON-encoded array of example prompts a user could try. */
    examplePrompts: text("example_prompts").notNull().default("[]"),
    category: text("category").notNull().default("Productivity"),
    /** Optional id of the skills row created when the user saves the draft locally. */
    skillId: text("skill_id"),
    /** Optional id of the store_skills row created when the user publishes. */
    publishedStoreSkillId: text("published_store_skill_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_drafts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_drafts_workspace").on(t.workspaceId),
    statusIdx: index("idx_skill_drafts_status").on(t.tenantId, t.status),
    createdIdx: index("idx_skill_drafts_created").on(t.tenantId, t.createdAt),
  }),
);

export type SkillDraft = typeof skillDrafts.$inferSelect;
export type NewSkillDraft = typeof skillDrafts.$inferInsert;
