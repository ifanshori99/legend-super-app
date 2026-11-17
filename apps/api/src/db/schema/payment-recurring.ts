// DOIT recurring billing tables (bead 6c6; PRD F13 "subscription_invoices").
//
// All three are tenant + outlet owned (T): `tenant_id` and `outlet_id` NOT NULL,
// a composite `(tenant_id, id)` key, composite FKs through the tenant, RLS in
// the `payment_recurring_billing_rls` migration. Money is whole rupiah in
// BIGINT (D-CORE-2). Statuses are varchar + CHECK. The plan price here is the
// server truth: an invoice whose amount differs is parked as `needs_review`.
// `customer_profile_id` stays a plain UUID (no FK), like the payment.ts header.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
} from "../columns";
import { tenantIntegrations } from "./platform-integrations";
import { outlets, tenants } from "./platform-org";

export type RecurringPlanInterval = "month" | "week";
export type RecurringPlanStatus = "active" | "archived";
export type RecurringSubscriptionStatus =
  | "pending_first_payment"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  // Start intent stored before the DOIT call, and a start/pause/resume/cancel
  // whose outcome at the gateway is unconfirmed: never notified, never active.
  | "provisioning"
  | "needs_reconcile";
export type SubscriptionInvoiceStatus =
  "open" | "paid" | "void" | "expired" | "needs_review";

export const paymentRecurringPlans = pgTable(
  "payment_recurring_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    provider: varchar("provider", { length: 20 }).notNull().default("doit"),
    providerPlanId: varchar("provider_plan_id", { length: 100 }).notNull(),
    /** DOIT integration that owns the plan; its webhooks must be signed by it. */
    gatewayIntegrationId: uuid("gateway_integration_id").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    /** Server truth for the price of every invoice of this plan. */
    amountIdr: idrColumn("amount_idr").notNull(),
    interval: varchar("interval", { length: 10 })
      .$type<RecurringPlanInterval>()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<RecurringPlanStatus>()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_recurring_plans_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("payment_recurring_plans_provider_plan_key").on(
      table.tenantId,
      table.provider,
      table.providerPlanId,
    ),
    foreignKey({
      name: "payment_recurring_plans_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // tenant_integrations has no (tenant_id, id) key: plain key, like payment_intents.
    foreignKey({
      name: "payment_recurring_plans_gateway_integration_fk",
      columns: [table.gatewayIntegrationId],
      foreignColumns: [tenantIntegrations.id],
    }),
    index("payment_recurring_plans_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    check(
      "payment_recurring_plans_provider_check",
      sql`${table.provider} IN ('doit')`,
    ),
    check("payment_recurring_plans_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "payment_recurring_plans_interval_check",
      sql`${table.interval} IN ('month', 'week')`,
    ),
    check(
      "payment_recurring_plans_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export const paymentRecurringSubscriptions = pgTable(
  "payment_recurring_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    planId: uuid("plan_id").notNull(),
    /** Copied from the plan; an invoice webhook signed by another integration is refused. */
    gatewayIntegrationId: uuid("gateway_integration_id").notNull(),
    /** Plain UUID, no FK (customer profiles live in another workstream). */
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** Null only while `provisioning` / `needs_reconcile`, or `cancelled` for a
     * start intent DOIT confirmed it never created (see the CHECK). */
    providerSubscriptionId: varchar("provider_subscription_id", {
      length: 100,
    }),
    /** Caller's start key; with the row id as DOIT `reference` it makes a start
     * retry resend the same request instead of creating a second subscription. */
    startIdempotencyKey: varchar("start_idempotency_key", { length: 200 }),
    /** Error code only, e.g. PROVIDER_ERROR; never a message or payload. */
    reconcileReason: varchar("reconcile_reason", { length: 100 }),
    status: varchar("status", { length: 30 })
      .$type<RecurringSubscriptionStatus>()
      .notNull()
      .default("pending_first_payment"),
    currentPeriodStart: businessDate("current_period_start"),
    currentPeriodEnd: businessDate("current_period_end"),
    /** A paid period that starts later than today: kept apart until its start
     * date, when it replaces the current period (promotion). */
    nextPeriodStart: businessDate("next_period_start"),
    nextPeriodEnd: businessDate("next_period_end"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_recurring_subscriptions_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("payment_recurring_subscriptions_provider_sub_key").on(
      table.tenantId,
      table.providerSubscriptionId,
    ),
    foreignKey({
      name: "payment_recurring_subscriptions_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "payment_recurring_subscriptions_plan_fk",
      columns: [table.tenantId, table.planId],
      foreignColumns: [
        paymentRecurringPlans.tenantId,
        paymentRecurringPlans.id,
      ],
    }),
    foreignKey({
      name: "payment_recurring_subscriptions_gateway_integration_fk",
      columns: [table.gatewayIntegrationId],
      foreignColumns: [tenantIntegrations.id],
    }),
    // Partial: only a start request carries a key.
    uniqueIndex("payment_recurring_subscriptions_start_key")
      .on(table.tenantId, table.startIdempotencyKey)
      .where(sql`${table.startIdempotencyKey} IS NOT NULL`),
    // Brief 488 item 1: one pending or active subscription per customer and
    // plan, whatever the idempotency key. `provisioning` / `needs_reconcile`
    // rows hold no provider id yet and are guarded by the per customer + plan
    // lock in `startSubscription`.
    uniqueIndex("payment_recurring_subscriptions_live_customer_plan_key")
      .on(table.tenantId, table.planId, table.customerProfileId)
      .where(sql`${table.status} IN ('pending_first_payment', 'active')`),
    // Bead legend-yqne1 / legend-ycb85: one unresolved (provisioning or
    // needs_reconcile) row per customer and plan, with or without a DOIT id,
    // so a second start can never sit next to a row DOIT may still charge for.
    uniqueIndex("payment_recurring_subscriptions_unresolved_customer_plan_key")
      .on(table.tenantId, table.planId, table.customerProfileId)
      .where(sql`${table.status} IN ('provisioning', 'needs_reconcile')`),
    index("payment_recurring_subscriptions_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
    ),
    index("payment_recurring_subscriptions_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
    ),
    check(
      "payment_recurring_subscriptions_status_check",
      sql`${table.status} IN ('pending_first_payment', 'active', 'past_due', 'paused', 'cancelled', 'provisioning', 'needs_reconcile')`,
    ),
    check(
      "payment_recurring_subscriptions_provider_sub_check",
      sql`${table.providerSubscriptionId} IS NOT NULL OR ${table.status} IN ('provisioning', 'needs_reconcile', 'cancelled')`,
    ),
    check(
      "payment_recurring_subscriptions_next_period_check",
      sql`(${table.nextPeriodStart} IS NULL) = (${table.nextPeriodEnd} IS NULL) AND (${table.nextPeriodStart} IS NULL OR ${table.nextPeriodEnd} > ${table.nextPeriodStart})`,
    ),
    check(
      "payment_recurring_subscriptions_period_check",
      sql`(${table.currentPeriodStart} IS NULL) = (${table.currentPeriodEnd} IS NULL) AND (${table.currentPeriodStart} IS NULL OR ${table.currentPeriodEnd} > ${table.currentPeriodStart})`,
    ),
  ],
);

export const subscriptionInvoices = pgTable(
  "subscription_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    providerInvoiceId: varchar("provider_invoice_id", {
      length: 100,
    }).notNull(),
    periodStart: businessDate("period_start").notNull(),
    periodEnd: businessDate("period_end").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    hostedUrl: text("hosted_url").notNull(),
    status: varchar("status", { length: 20 })
      .$type<SubscriptionInvoiceStatus>()
      .notNull()
      .default("open"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Set once, in the same tx as the notification outbox row. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** Error code only, e.g. AMOUNT_MISMATCH; never a message or payload. */
    reviewReason: varchar("review_reason", { length: 64 }),
    /** gateway_webhook_events id (plain UUID) of the event that created it. */
    sourceEventId: uuid("source_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("subscription_invoices_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("subscription_invoices_provider_invoice_key").on(
      table.tenantId,
      table.providerInvoiceId,
    ),
    // Partial: a void/expired/needs_review invoice does not hold the period, but
    // a second invoice for a period held by an open/paid one is parked as
    // needs_review (DUPLICATE_PERIOD), never silently ignored.
    uniqueIndex("subscription_invoices_sub_period_key")
      .on(table.tenantId, table.subscriptionId, table.periodStart)
      .where(sql`${table.status} IN ('open', 'paid')`),
    foreignKey({
      name: "subscription_invoices_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "subscription_invoices_subscription_fk",
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [
        paymentRecurringSubscriptions.tenantId,
        paymentRecurringSubscriptions.id,
      ],
    }),
    index("subscription_invoices_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt.desc(),
    ),
    check("subscription_invoices_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "subscription_invoices_period_check",
      sql`${table.periodEnd} > ${table.periodStart}`,
    ),
    check(
      "subscription_invoices_status_check",
      sql`${table.status} IN ('open', 'paid', 'void', 'expired', 'needs_review')`,
    ),
    check(
      "subscription_invoices_hosted_url_check",
      sql`${table.hostedUrl} ~ '^https://'`,
    ),
    check(
      "subscription_invoices_review_reason_check",
      sql`${table.status} <> 'needs_review' OR ${table.reviewReason} IS NOT NULL`,
    ),
  ],
);

// Per-outlet grace setting (PRD: grace days per outlet, default 3, may be 0).
// No row = default 3. The overdue worker and the access check read it.
export const paymentRecurringOutletSettings = pgTable(
  "payment_recurring_outlet_settings",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    graceDays: integer("grace_days").notNull().default(3),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "payment_recurring_outlet_settings_pkey",
      columns: [table.tenantId, table.outletId],
    }),
    foreignKey({
      name: "payment_recurring_outlet_settings_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "payment_recurring_outlet_settings_grace_days_check",
      sql`${table.graceDays} BETWEEN 0 AND 30`,
    ),
  ],
);

export type PaymentRecurringPlan = typeof paymentRecurringPlans.$inferSelect;
export type NewPaymentRecurringPlan = typeof paymentRecurringPlans.$inferInsert;
export type PaymentRecurringSubscription =
  typeof paymentRecurringSubscriptions.$inferSelect;
export type NewPaymentRecurringSubscription =
  typeof paymentRecurringSubscriptions.$inferInsert;
export type SubscriptionInvoice = typeof subscriptionInvoices.$inferSelect;
export type NewSubscriptionInvoice = typeof subscriptionInvoices.$inferInsert;
