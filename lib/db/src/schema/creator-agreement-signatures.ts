/**
 * `creator_agreement_signatures` — append-only ledger of Creator
 * Agreement digital signatures. Re-signing after a material version
 * bump inserts a new row; the previous row stays as proof of historic
 * consent (Standard 6 carve-out for audit-class tables — no `version`
 * column).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { creatorAccounts } from "./creator-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const creatorAgreementSignatures = sqliteTable(
  "creator_agreement_signatures",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    creatorId: text("creator_id").notNull().references(() => creatorAccounts.id),
    agreementVersion: text("agreement_version").notNull(),
    agreementHash: text("agreement_hash").notNull(),
    signedName: text("signed_name").notNull(),
    signedAt: integer("signed_at").notNull().default(sql`(unixepoch() * 1000)`),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    locale: text("locale"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_creator_agreement_sigs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_creator_agreement_sigs_workspace").on(t.workspaceId),
    creatorIdx: index("idx_creator_agreement_sigs_creator").on(t.creatorId),
    versionIdx: index("idx_creator_agreement_sigs_version").on(
      t.creatorId,
      t.agreementVersion,
    ),
  }),
);

export type CreatorAgreementSignature = typeof creatorAgreementSignatures.$inferSelect;
export type NewCreatorAgreementSignature = typeof creatorAgreementSignatures.$inferInsert;
