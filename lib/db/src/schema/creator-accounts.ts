/**
 * `creator_accounts` — hosted Skill Store creator profiles.
 *
 * Although the v1 implementation runs the "store" inside the same API
 * server (so creator records sit alongside local data), each creator row
 * is logically global to the store: a `handle` is unique across all
 * creators regardless of tenant, mirroring how a real hosted store would
 * issue handles. We still scope rows by `tenantId` + `workspaceId` so the
 * canonical multi-tenant helpers keep working — the *owning* tenant is
 * the one that signed the creator up.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const creatorAccounts = sqliteTable(
  "creator_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** Globally-unique store handle (slug-shaped, lowercase). */
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    bio: text("bio").notNull().default(""),
    /** Optional public link to the creator's book/course/site. */
    websiteUrl: text("website_url"),
    /** JSON-encoded array of {label,url} external links the creator wants surfaced. */
    externalLinks: text("external_links").notNull().default("[]"),
    /** Local-only: opaque token granted at signup; surfaced once to the client and
     *  then required on every publish. Stored hashed so the raw value can't be lifted from disk. */
    apiTokenHash: text("api_token_hash").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_creator_accounts_tenant").on(t.tenantId),
    workspaceIdx: index("idx_creator_accounts_workspace").on(t.workspaceId),
    handleIdx: uniqueIndex("uq_creator_accounts_handle").on(t.handle),
  }),
);

export type CreatorAccount = typeof creatorAccounts.$inferSelect;
export type NewCreatorAccount = typeof creatorAccounts.$inferInsert;
