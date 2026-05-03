/**
 * `creator_tax_documents` — generated 1099-K / 1099-MISC / annual
 * summary documents delivered to creators. Append-only audit-class
 * table (no `version` column); a unique index per (creator, tax_year,
 * type) enforces the legal one-document-per-year invariant.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { creatorAccounts } from "./creator-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const creatorTaxDocuments = sqliteTable(
  "creator_tax_documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    creatorId: text("creator_id").notNull().references(() => creatorAccounts.id),
    documentType: text("document_type").notNull(),
    taxYear: integer("tax_year").notNull(),
    grossAmountCents: integer("gross_amount_cents").notNull().default(0),
    transactionCount: integer("transaction_count").notNull().default(0),
    backupWithholdingCents: integer("backup_withholding_cents").notNull().default(0),
    body: text("body").notNull(),
    bodyHash: text("body_hash").notNull(),
    status: text("status").notNull().default("issued"),
    deliveredAt: integer("delivered_at"),
    filedAt: integer("filed_at"),
    irsConfirmationId: text("irs_confirmation_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_creator_tax_docs_tenant").on(t.tenantId),
    workspaceIdx: index("idx_creator_tax_docs_workspace").on(t.workspaceId),
    creatorIdx: index("idx_creator_tax_docs_creator").on(t.creatorId),
    yearTypeIdx: uniqueIndex("uq_creator_tax_docs_year_type").on(
      t.creatorId,
      t.taxYear,
      t.documentType,
    ),
  }),
);

export type CreatorTaxDocument = typeof creatorTaxDocuments.$inferSelect;
export type NewCreatorTaxDocument = typeof creatorTaxDocuments.$inferInsert;
