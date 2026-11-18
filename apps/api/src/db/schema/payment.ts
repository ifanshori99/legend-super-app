// Payment tables (bead legend-gz3; PRD v1.7 §3.13 F13 "Orkestrasi
// Pembayaran", §6 D `payment_intents` / `unallocated_funds`).
//
// Every operational table is tenant-owned (T): `tenant_id` NOT NULL, an
// `outlet_id` for rows that belong to one outlet, a composite `(tenant_id, id)`
// key so children cannot point at another tenant's row, and enforced RLS in the
// `payment_rls` migration (`app.enforce_tenant_rls`). Money is whole rupiah in
// BIGINT (PAY-01, D-CORE-2), never a float.
//
// `payment_link_tokens` is the exception: it is the guest credential index read
// BEFORE a tenant context exists, exactly like `tenant_domains`. It stores only
// a SHA-256 hash of the link token plus the tenant/outlet/link ids — never an
// amount, name or bill line — and its migration installs an open SELECT policy
// with tenant-checked writes (see `payment_rls` and the RLS catalog test).
//
// The intent's aggregate references (order, reservation, access ticket,
// subscription invoice) stay plain UUID columns: those aggregates land with
// WS-03/04/08/09 and a foreign key across a table that does not exist yet
// would block every migration. The composite keys that exist today (outlet,
// payment link, bill split) are declared.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import type {
  PaymentInstructions,
  PaymentMethod,
  PaymentStatus,
} from "@starter/shared/payment";
import { idrColumn, outletIdColumn, tenantIdColumn } from "../columns";
import { billSplits } from "./bill-splits";
import { outlets, tenants } from "./platform-org";
import { tenantIntegrations } from "./platform-integrations";

/** PRD §6 D `flags`; "late_payment" marks a payment that landed after expiry. */
export type PaymentFlag = "late_payment" | "double_payment";
/** Why a settled intent left money unallocated (PRD PAY-04). */
export type UnallocatedFundsReason = "overpayment" | "double_payment";

/**
 * One guest payment link (PRD §3.13, D24). The bill snapshot is priced by the
 * server; the link only carries what the guest still has to pay. `token_hash`
 * is the SHA-256 of the token handed to the guest once — the plaintext token is
 * never stored.
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    reference: varchar("reference", { length: 40 }).notNull(),
    tableLabel: varchar("table_label", { length: 40 }),
    pax: integer("pax"),
    subtotalIdr: idrColumn("subtotal_idr").notNull(),
    discountIdr: idrColumn("discount_idr").notNull().default(idr(0)),
    serviceChargeIdr: idrColumn("service_charge_idr").notNull().default(idr(0)),
    taxIdr: idrColumn("tax_idr").notNull().default(idr(0)),
    /** Rounding line of the bill (owner decision 12: tax added at checkout). */
    roundingIdr: idrColumn("rounding_idr").notNull().default(idr(0)),
    totalIdr: idrColumn("total_idr").notNull(),
    paidIdr: idrColumn("paid_idr").notNull().default(idr(0)),
    /** App-local path the payment screen returns to, e.g. the table session. */
    returnPath: varchar("return_path", { length: 300 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_links_token_hash_key").on(table.tokenHash),
    unique("payment_links_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "payment_links_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("payment_links_outlet_created_idx").on(
      table.tenantId,
      table.outletId,
      table.createdAt.desc(),
    ),
    // The bill total the guest pays must add up from the server-priced parts.
    check(
      "payment_links_total_check",
      sql`${table.totalIdr} = ${table.subtotalIdr} - ${table.discountIdr} + ${table.serviceChargeIdr} + ${table.taxIdr} + ${table.roundingIdr}`,
    ),
    check(
      "payment_links_paid_check",
      sql`${table.paidIdr} BETWEEN 0 AND ${table.totalIdr}`,
    ),
    check(
      "payment_links_amounts_check",
      sql`${table.subtotalIdr} >= 0 AND ${table.discountIdr} >= 0 AND ${table.serviceChargeIdr} >= 0 AND ${table.taxIdr} >= 0 AND ${table.totalIdr} >= 0`,
    ),
    // A table bill carries the table label and the guest count together.
    check(
      "payment_links_table_pair_check",
      sql`(${table.tableLabel} IS NULL) = (${table.pax} IS NULL)`,
    ),
    check(
      "payment_links_pax_check",
      sql`${table.pax} IS NULL OR ${table.pax} BETWEEN 1 AND 30`,
    ),
    check(
      "payment_links_return_path_check",
      sql`${table.returnPath} IS NULL OR ${table.returnPath} ~ '^/(?!/)'`,
    ),
  ],
);

/**
 * Bootstrap credential index: token hash -> tenant/outlet/link, readable before
 * a tenant context exists (TEN-02, same rule as `tenant_domains`). It holds no
 * business data, so an open SELECT cannot leak a bill, a guest or an amount.
 */
export const paymentLinkTokens = pgTable(
  "payment_link_tokens",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
    paymentLinkId: uuid("payment_link_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // A token can only point at a link of the same tenant.
    foreignKey({
      name: "payment_link_tokens_link_fk",
      columns: [table.tenantId, table.paymentLinkId],
      foreignColumns: [paymentLinks.tenantId, paymentLinks.id],
    }).onDelete("cascade"),
    index("payment_link_tokens_expiry_idx").on(table.expiresAt),
  ],
);

/**
 * `payment_intents` (PRD §6 D). `idempotency_key` is unique per tenant
 * (PAY-01): a retried create returns the first intent, and the same key with a
 * different request fails IDEMPOTENCY_KEY_REUSED. Settled statuses always
 * record `paid_at`; unpaid ones never do (the contract refinement).
 */
export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** The link this intent was minted through; internal, not on the wire. */
    paymentLinkId: uuid("payment_link_id").notNull(),
    orderId: uuid("order_id"),
    billSplitId: uuid("bill_split_id"),
    reservationId: uuid("reservation_id"),
    accessTicketId: uuid("access_ticket_id"),
    subscriptionInvoiceId: uuid("subscription_invoice_id"),
    method: varchar("method", { length: 20 }).$type<PaymentMethod>().notNull(),
    provider: varchar("provider", { length: 20 }).notNull(),
    /** Server-priced, whole rupiah (PAY-01). */
    amountIdr: idrColumn("amount_idr").notNull(),
    feeIdr: idrColumn("fee_idr").notNull().default(idr(0)),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    providerRef: varchar("provider_ref", { length: 100 }),
    /** `tenant_integrations` row whose credentials minted `provider_ref`.
     * Status checks and webhook binding use this row, even after an outlet
     * gets its own integration or this one is disabled, so money already in
     * flight is still verified against the account that created it. Null on
     * rows minted before it existed (resolve by outlet as before). */
    gatewayIntegrationId: uuid("gateway_integration_id"),
    status: varchar("status", { length: 20 })
      .$type<PaymentStatus>()
      .notNull()
      .default("pending"),
    flags: text("flags")
      .array()
      .$type<PaymentFlag[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    edcTransactionId: uuid("edc_transaction_id"),
    /** What the guest needs on screen; minted by the gateway adapter. */
    instructions: jsonb("instructions").$type<PaymentInstructions>().notNull(),
    /** Bank/channel code for `va`/`bank_transfer`; null for QRIS. */
    channelCode: varchar("channel_code", { length: 40 }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Last time the polling fallback asked the gateway; null = never. Lets
     * the poller rotate so an erroring intent cannot starve the others. */
    gatewayPolledAt: timestamp("gateway_polled_at", { withTimezone: true }),
    /** Poller lease: a worker that claimed this intent holds it until then, so
     * two workers never ask the gateway about the same intent at once. Null or
     * in the past = free. A crashed worker's lease simply lapses. */
    gatewayPollLeaseUntil: timestamp("gateway_poll_lease_until", {
      withTimezone: true,
    }),
    /** SO-885: when the PROVIDER answered final for this code (expired,
     * failed, cancelled) or its money was reconciled. Local time never sets
     * it: an `expired` code with a provider reference and no value here may
     * still take money, so nothing replaces it and the poller keeps asking. */
    providerFinalAt: timestamp("provider_final_at", { withTimezone: true }),
    /** legend-3wpf: when the PROVIDER first answered about this code with a
     * terminal status (expired, failed, refunded) or its money was reconciled.
     * Unlike `provider_final_at` it is also set by an answer given before the
     * code lapsed (a retryable attempt). Never inferred from `updated_at`,
     * which any unrelated touch of the row moves. Null = no answer yet. */
    providerAnsweredAt: timestamp("provider_answered_at", {
      withTimezone: true,
    }),
    /** legend-3wpf (952 P1): when the PROVIDER first answered `refunded` for
     * this code: the money went back to the payer, so no later `paid` message
     * may settle the bill. Kept apart from the `failed` status a refunded
     * answer maps to, so a plain `failed` code that is paid late still
     * reconciles once. Null = never answered refunded. */
    providerRefundedAt: timestamp("provider_refunded_at", {
      withTimezone: true,
    }),
    /** legend-7uqbs (958): when the PROVIDER first answered `refunded` for the
     * payment of a SETTLED (paid) intent: its money went back to the payer, so
     * no second refund may be paid out. Kept apart from `provider_refunded_at`,
     * which turns a later `paid` message into a rejected one (a paid intent
     * must keep treating the replay of its own paid message as a replay).
     * Null = never answered refunded. */
    providerRefundedAfterPaidAt: timestamp("provider_refunded_after_paid_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_intents_tenant_idempotency_key").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    unique("payment_intents_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "payment_intents_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "payment_intents_link_fk",
      columns: [table.tenantId, table.paymentLinkId],
      foreignColumns: [paymentLinks.tenantId, paymentLinks.id],
    }),
    // legend-ms3: a split part's intent. A null bill_split_id (every other
    // intent) is not checked (MATCH SIMPLE).
    foreignKey({
      name: "payment_intents_bill_split_fk",
      columns: [table.tenantId, table.billSplitId],
      foreignColumns: [billSplits.tenantId, billSplits.id],
    }),
    // tenant_integrations has no (tenant_id, id) key, so a plain key; the
    // adapter only ever stores the id of a row it loaded in this tenant.
    foreignKey({
      name: "payment_intents_gateway_integration_fk",
      columns: [table.gatewayIntegrationId],
      foreignColumns: [tenantIntegrations.id],
    }),
    // Expiry sweep and POS/admin lists: tenant + outlet + status + expiry.
    index("payment_intents_status_expiry_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.expiresAt,
    ),
    index("payment_intents_link_status_idx").on(
      table.tenantId,
      table.paymentLinkId,
      table.status,
    ),
    // Refund authority finds the other intents of a bill by order, split and
    // reservation (the link side is payment_intents_link_status_idx); 0285.
    index("payment_intents_order_idx")
      .on(table.tenantId, table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    index("payment_intents_bill_split_idx")
      .on(table.tenantId, table.billSplitId)
      .where(sql`${table.billSplitId} IS NOT NULL`),
    index("payment_intents_reservation_idx")
      .on(table.tenantId, table.reservationId)
      .where(sql`${table.reservationId} IS NOT NULL`),
    check("payment_intents_amount_check", sql`${table.amountIdr} > 0`),
    check("payment_intents_fee_check", sql`${table.feeIdr} >= 0`),
    check(
      "payment_intents_status_check",
      sql`${table.status} IN ('pending', 'paid', 'expired', 'failed', 'refunded', 'partially_refunded')`,
    ),
    check(
      "payment_intents_method_check",
      sql`${table.method} IN ('qris', 'card', 'ewallet', 'va', 'bank_transfer', 'paylater', 'cash', 'edc_card', 'edc_qris', 'points', 'voucher')`,
    ),
    check(
      "payment_intents_flags_check",
      sql`${table.flags} <@ ARRAY['late_payment', 'double_payment']::text[]`,
    ),
    // PAY-01/PAY-02: a settled intent has a paid_at, an unsettled one never.
    check(
      "payment_intents_paid_at_check",
      sql`(${table.status} IN ('paid', 'partially_refunded', 'refunded')) = (${table.paidAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Gateway routing per method, per tenant (outlet_id NULL) or per outlet
 * (PRD §3.13 "Routing per Metode"). Changing a row redirects new transactions
 * only; it never rewrites an order, a journal or a report (PAY-05).
 */
export const paymentRoutingRules = pgTable(
  "payment_routing_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** NULL is the tenant default, which an outlet row can override. */
    outletId: uuid("outlet_id"),
    method: varchar("method", { length: 20 }).$type<PaymentMethod>().notNull(),
    // Provider codes follow the WS-05 admin contract (max 100, PRD §3.13).
    provider: varchar("provider", { length: 100 }).notNull(),
    fallbackProvider: varchar("fallback_provider", { length: 100 }),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One rule per method at each level (NULL does not dedupe in a unique key).
    uniqueIndex("payment_routing_rules_tenant_default_key")
      .on(table.tenantId, table.method)
      .where(sql`${table.outletId} IS NULL`),
    uniqueIndex("payment_routing_rules_tenant_outlet_key")
      .on(table.tenantId, table.outletId, table.method)
      .where(sql`${table.outletId} IS NOT NULL`),
    unique("payment_routing_rules_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "payment_routing_rules_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "payment_routing_rules_method_check",
      sql`${table.method} IN ('qris', 'card', 'ewallet', 'va', 'bank_transfer', 'paylater', 'cash', 'edc_card', 'edc_qris', 'points', 'voucher')`,
    ),
    check(
      "payment_routing_rules_provider_check",
      sql`${table.provider} <> '' AND (${table.fallbackProvider} IS NULL OR ${table.fallbackProvider} <> '')`,
    ),
  ],
);

/**
 * Money that arrived but belongs to no bill remainder (PRD PAY-04): a second
 * payment for the same intent, or a payment above the amount due. It is only
 * closed by a refund or a credit with approval, never deleted.
 */
export const paymentUnallocatedFunds = pgTable(
  "payment_unallocated_funds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    /**
     * Provider evidence that brought this money in; null on rows that predate it.
     * Soft reference (no FK): adding a validated FK to this RLS-forced table
     * fails for a non-superuser migrator, and evidence is append-only anyway.
     */
    evidenceId: uuid("evidence_id"),
    amountIdr: idrColumn("amount_idr").notNull(),
    reason: varchar("reason", { length: 20 })
      .$type<UnallocatedFundsReason>()
      .notNull(),
    resolution: varchar("resolution", { length: 20 }),
    resolvedBy: text("resolved_by"),
    /** Reference of the approved refund/credit request (PRD PAY-04). */
    approvalRef: varchar("approval_ref", { length: 100 }),
    note: text("note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** legend-7uqbs (958): when the PROVIDER first answered `refunded` for the
     * transaction behind this fund: the money already went back to the payer,
     * so it must not be resolved into a second refund. Set once by a
     * conditional UPDATE; null = never answered refunded. */
    providerRefundedAt: timestamp("provider_refunded_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_unallocated_funds_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "payment_unallocated_funds_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "payment_unallocated_funds_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // One fund per provider evidence: a refund of a fund pays back exactly the
    // transaction that brought it in, so two funds can never share one.
    uniqueIndex("payment_unallocated_funds_evidence_key")
      .on(table.tenantId, table.evidenceId)
      .where(sql`${table.evidenceId} IS NOT NULL`),
    index("payment_unallocated_funds_open_idx").on(
      table.tenantId,
      table.outletId,
      table.resolvedAt,
    ),
    check(
      "payment_unallocated_funds_amount_check",
      sql`${table.amountIdr} > 0`,
    ),
    check(
      "payment_unallocated_funds_reason_check",
      sql`${table.reason} IN ('overpayment', 'double_payment')`,
    ),
    check(
      "payment_unallocated_funds_resolution_check",
      sql`${table.resolution} IS NULL OR ${table.resolution} IN ('refund', 'credit')`,
    ),
    // Unresolved rows carry no resolver; a resolution always names one.
    check(
      "payment_unallocated_funds_resolved_check",
      sql`(${table.resolution} IS NULL AND ${table.resolvedBy} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.resolution} IS NOT NULL AND ${table.resolvedBy} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Payment evidence identity (PRD PAY-02/PAY-04): one row per provider
 * transaction the settlement path applied. The unique
 * `(tenant_id, provider, provider_ref)` key makes a retried webhook or status
 * check idempotent, including a retried second payment: the money row
 * (`payment_unallocated_funds`) is written once per real transaction, never
 * once per delivery attempt.
 */
export const paymentEvidence = pgTable(
  "payment_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    /** Gateway that issued the reference (`doit`, `edc`, ...). */
    provider: varchar("provider", { length: 20 }).notNull(),
    /** Provider transaction id; the evidence identity itself. */
    providerRef: varchar("provider_ref", { length: 100 }).notNull(),
    method: varchar("method", { length: 20 }).$type<PaymentMethod>().notNull(),
    /** Verified source label (contract `PaymentConfirmationSource`). */
    source: varchar("source", { length: 30 }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    /** When the provider/staff confirmed the money (confirmation `at`). */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_evidence_tenant_id_id_key").on(table.tenantId, table.id),
    // A provider transaction backs exactly one intent; retries hit this key.
    unique("payment_evidence_provider_ref_key").on(
      table.tenantId,
      table.provider,
      table.providerRef,
    ),
    foreignKey({
      name: "payment_evidence_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "payment_evidence_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("payment_evidence_intent_idx").on(
      table.tenantId,
      table.paymentIntentId,
      table.receivedAt,
    ),
    check("payment_evidence_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "payment_evidence_source_check",
      sql`${table.source} IN ('verified_webhook', 'gateway_status', 'edc_ecr', 'authorized_cash', 'authorized_edc_standalone')`,
    ),
    check(
      "payment_evidence_method_check",
      sql`${table.method} IN ('qris', 'card', 'ewallet', 'va', 'bank_transfer', 'paylater', 'cash', 'edc_card', 'edc_qris', 'points', 'voucher')`,
    ),
  ],
);

/**
 * legend-30hfs (967): one row per refund the PROVIDER made on its own (not the
 * echo of a refund we sent), for money we had already recorded as paid. The
 * unique `(tenant_id, provider, provider_refund_id)` key makes a retried
 * webhook, a poller and a webhook racing each other record it once; the winner
 * of the insert writes the audit row and the supervisor alert. The sum of the
 * rows of an intent (`providerRefundedForeignIdrSql`) is taken off what the
 * intent may still refund or pay out (refunds that fit in the parked excess of
 * the same transaction are left out, legend-g6ept). Append-only evidence:
 * never updated.
 */
export const paymentProviderRefunds = pgTable(
  "payment_provider_refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    /** The provider transaction (evidence) the refund belongs to, when the
     * transaction was recorded as evidence. */
    evidenceId: uuid("evidence_id"),
    provider: varchar("provider", { length: 20 }).notNull(),
    /** The provider's own refund id (the identity with tenant and provider). */
    providerRefundId: varchar("provider_refund_id", { length: 100 }).notNull(),
    /** The provider transaction the refund names. */
    providerPaymentRef: varchar("provider_payment_ref", {
      length: 100,
    }).notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    /** Which path saw it first: `refund_webhook`, `payment_webhook`, `poller`. */
    source: varchar("source", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("payment_provider_refunds_provider_refund_key").on(
      table.tenantId,
      table.provider,
      table.providerRefundId,
    ),
    foreignKey({
      name: "payment_provider_refunds_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    foreignKey({
      name: "payment_provider_refunds_evidence_fk",
      columns: [table.tenantId, table.evidenceId],
      foreignColumns: [paymentEvidence.tenantId, paymentEvidence.id],
    }),
    foreignKey({
      name: "payment_provider_refunds_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("payment_provider_refunds_intent_idx").on(
      table.tenantId,
      table.paymentIntentId,
    ),
    check("payment_provider_refunds_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "payment_provider_refunds_source_check",
      sql`${table.source} IN ('refund_webhook', 'payment_webhook', 'poller')`,
    ),
  ],
);
