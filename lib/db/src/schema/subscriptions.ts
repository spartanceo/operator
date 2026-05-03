/**
 * `subscriptions` — per-tenant record of the operator's monetisation
 * subscription. Status mirrors Stripe's lifecycle: `inactive` (no row /
 * never subscribed), `trialing`, `active`, `past_due`, `cancelled`.
 *
 * The Stripe identifiers stay nullable so the subscription service can
 * run in fully-offline / stub mode (the default for local installs that
 * never touch the network). When `OMNINITY_STRIPE_SECRET` is set the
 * webhook handler back-fills `stripeCustomerId` + `stripeSubscriptionId`.
 *
 * One row per tenant — enforced by a unique index on `tenant_id`.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** inactive | trialing | active | past_due | cancelled */
    status: text("status").notNull().default("inactive"),
    /** Marketing plan slug — currently always `creator_pro`. */
    planId: text("plan_id").notNull().default("creator_pro"),
    /** Monthly price the user signed up at, in cents. Captured for invoices. */
    priceCents: integer("price_cents").notNull().default(1900),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** Unix ms — when the current paid period ends. */
    currentPeriodEnd: integer("current_period_end"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
    /** True when the user cancelled mid-period; access continues until period end. */
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => ({
    tenantIdx: uniqueIndex("uq_subscriptions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_subscriptions_workspace").on(t.workspaceId),
    statusIdx: index("idx_subscriptions_status").on(t.status),
  }),
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
