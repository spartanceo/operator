/**
 * `creator_tax_forms` — encrypted W-9 / W-8BEN tax-id collection.
 *
 * `encrypted_payload` is the AES-GCM ciphertext of the raw form JSON.
 * `tax_id_fingerprint` is a SHA-256 hash of the canonicalised tax id
 * used for dedup checks; never decrypt the payload to perform lookups.
 *
 * Submitting a new form supersedes the previous active row (status
 * flips to `superseded`), giving us a tamper-resistant history while
 * still allowing only one current form per creator.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { creatorAccounts } from "./creator-accounts";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const creatorTaxForms = sqliteTable(
  "creator_tax_forms",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    creatorId: text("creator_id").notNull().references(() => creatorAccounts.id),
    formType: text("form_type").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    taxIdFingerprint: text("tax_id_fingerprint").notNull(),
    countryCode: text("country_code").notNull(),
    status: text("status").notNull().default("active"),
    valid: integer("valid").notNull().default(1),
    backupWithholdingBps: integer("backup_withholding_bps").notNull().default(0),
    submittedAt: integer("submitted_at").notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_creator_tax_forms_tenant").on(t.tenantId),
    workspaceIdx: index("idx_creator_tax_forms_workspace").on(t.workspaceId),
    creatorIdx: index("idx_creator_tax_forms_creator").on(t.creatorId),
    statusIdx: index("idx_creator_tax_forms_status").on(t.creatorId, t.status),
  }),
);

export type CreatorTaxForm = typeof creatorTaxForms.$inferSelect;
export type NewCreatorTaxForm = typeof creatorTaxForms.$inferInsert;
