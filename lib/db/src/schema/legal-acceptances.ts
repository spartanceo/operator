/**
 * `legal_acceptances` — append-only record of EULA / Privacy / Terms
 * acceptance. Re-acceptance after a material document update inserts a
 * new row rather than updating an existing one — proof of consent must
 * be tamper-resistant (Standard 6 carve-out for audit-class tables; the
 * `version` column is intentionally omitted).
 *
 * `documentVersion` and `documentHash` together pin the exact text the
 * user agreed to. The hash is computed from the canonical text content
 * served by the legal-documents catalogue at acceptance time, so we can
 * later prove the user saw the same words we ship today.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const legalAcceptances = sqliteTable(
  "legal_acceptances",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id"),
    documentType: text("document_type").notNull(),
    documentVersion: text("document_version").notNull(),
    documentHash: text("document_hash").notNull(),
    acceptedAt: integer("accepted_at").notNull().default(sql`(unixepoch() * 1000)`),
    locale: text("locale"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_legal_acceptances_tenant").on(t.tenantId),
    workspaceIdx: index("idx_legal_acceptances_workspace").on(t.workspaceId),
    docIdx: index("idx_legal_acceptances_doc").on(t.tenantId, t.documentType),
    acceptedIdx: index("idx_legal_acceptances_accepted").on(
      t.tenantId,
      t.acceptedAt,
    ),
  }),
);

export type LegalAcceptance = typeof legalAcceptances.$inferSelect;
export type NewLegalAcceptance = typeof legalAcceptances.$inferInsert;
