/**
 * `enterprise_model_distributions` — IT-admin approved fine-tuned models
 * and LoRA adapters distributed to every member of an enterprise org
 * (Task #47).
 *
 * Each row points at either a custom model or a LoRA adapter that the
 * admin pre-approved on their machine. When a member's client polls the
 * enterprise registry, approved rows are auto-installed into that
 * member's `custom_models` / `lora_adapters` table with `source =
 * "enterprise_push"` so they appear alongside the user's own imports.
 *
 * The actual binary file is stored at `sourcePath` (a path the admin
 * controls — typically a network share or signed URL). Distribution of
 * the bytes is out of scope here; this table records *which* assets are
 * approved and lets the IT admin manage them.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { enterpriseOrgs } from "./enterprise-orgs";
import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const enterpriseModelDistributions = sqliteTable(
  "enterprise_model_distributions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    orgId: text("org_id").notNull().references(() => enterpriseOrgs.id),
    /** `model` or `adapter`. */
    kind: text("kind").notNull(),
    /** Stable name members will see. */
    name: text("name").notNull(),
    displayName: text("display_name").notNull().default(""),
    description: text("description").notNull().default(""),
    /** Adapter rows: the base model the adapter was trained against. */
    baseModel: text("base_model").notNull().default(""),
    /** Path / URL the member client downloads the asset from. */
    sourcePath: text("source_path").notNull().default(""),
    fileSize: integer("file_size").notNull().default(0),
    sha256: text("sha256").notNull().default(""),
    /** `pending` | `approved` | `rejected`. */
    status: text("status").notNull().default("pending"),
    approvedBy: text("approved_by").notNull().default(""),
    approvedAt: integer("approved_at"),
    rejectionReason: text("rejection_reason").notNull().default(""),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_enterprise_model_distributions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_enterprise_model_distributions_workspace").on(t.workspaceId),
    orgIdx: index("idx_enterprise_model_distributions_org").on(t.orgId),
    statusIdx: index("idx_enterprise_model_distributions_status").on(t.orgId, t.status),
    kindIdx: index("idx_enterprise_model_distributions_kind").on(t.orgId, t.kind),
    nameUniqueIdx: uniqueIndex("uq_enterprise_model_distributions_name").on(
      t.orgId,
      t.kind,
      t.name,
    ),
  }),
);

export type EnterpriseModelDistribution = typeof enterpriseModelDistributions.$inferSelect;
export type NewEnterpriseModelDistribution = typeof enterpriseModelDistributions.$inferInsert;
