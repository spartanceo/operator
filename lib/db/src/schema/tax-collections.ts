/**
 * `tax_collections` — VAT/GST/sales-tax collected per transaction.
 * Drives the OSS / HMRC / ATO remittance reports. Append-only
 * audit-class ledger (no `version` column).
 *
 * `remittance_bucket` groups rows by the authority Omninity files
 * them with (e.g. `eu_oss` for the EU One-Stop-Shop quarterly return).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const taxCollections = sqliteTable(
  "tax_collections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    buyerCountry: text("buyer_country").notNull(),
    buyerRegion: text("buyer_region"),
    taxType: text("tax_type").notNull(),
    taxRateBps: integer("tax_rate_bps").notNull().default(0),
    netAmountCents: integer("net_amount_cents").notNull(),
    taxAmountCents: integer("tax_amount_cents").notNull(),
    grossAmountCents: integer("gross_amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    remittanceBucket: text("remittance_bucket").notNull().default("none"),
    invoiceNumber: text("invoice_number"),
    invoiceUrl: text("invoice_url"),
    isBusiness: integer("is_business").notNull().default(0),
    businessVatNumber: text("business_vat_number"),
    collectedAt: integer("collected_at").notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    tenantIdx: index("idx_tax_collections_tenant").on(t.tenantId),
    workspaceIdx: index("idx_tax_collections_workspace").on(t.workspaceId),
    countryIdx: index("idx_tax_collections_country").on(t.buyerCountry, t.collectedAt),
    bucketIdx: index("idx_tax_collections_bucket").on(t.remittanceBucket, t.collectedAt),
  }),
);

export type TaxCollection = typeof taxCollections.$inferSelect;
export type NewTaxCollection = typeof taxCollections.$inferInsert;
