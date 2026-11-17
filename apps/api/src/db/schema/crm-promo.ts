// Promo engine storage shared by POS, QR order and the website (PRD v1.7 §3.21
// "Promo Engine", "ROI Promo"; §3.25 minimum-spend facility reward; LOY-03;
// §6.C `promotions` / `vouchers`; bead legend-7x4g).
//
// The rule itself is the shared pure evaluator (`@starter/shared/crm`
// evaluatePromotion/applyPromotions); these tables hold the rules, the
// race-safe counters and what each order consumed:
// - `promotions.uses_total` / `spent_idr` are the global quota and budget
//   counters. The CHECK constraints make an over-redemption impossible even if
//   a service forgot its row lock (database backstop for the atomic guard).
// - `promotion_customer_usage` counts uses per customer for quotaPerCustomer.
// - `vouchers` are single-use codes; a multi-use promo code is
//   `promotions.code_hash`. Only SHA-256 digests of codes are stored.
// - `promotion_order_applications` + `promotion_redemptions` record what one
//   order consumed, bound to a request fingerprint, so redeem and release are
//   idempotent and a void gives exactly that back.
// - `facility_rewards` are minimum-spend facility access rewards (WS-09 issues
//   the entitlement from the `promo_application.redeemed` event).
//
// Customer quota, voucher and facility reward references use composite keys
// after customer profiles and facility products landed (legend-ba8p). Tenant
// RLS and outlet RLS are installed in migration 0034_promo_rls.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  PromoChannel,
  PromoFreeItem,
  PromoStackingPolicy,
  PromotionBenefit,
  PromotionOutletScope,
  PromotionCondition,
  PromotionApplicationResult,
  PromotionRuleSnapshot,
  PromotionStatus,
  VoucherSource,
  VoucherStatus,
} from "@starter/shared/crm";
import type { UserId } from "@starter/shared/core";
import type { VoucherSyncRecord } from "@starter/shared/edge";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { customerProfiles } from "./crm-member";
import { facilityProducts } from "./facility";
import { syncTxidColumn } from "./sync-txid";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** One promotion rule (§6.C `promotions` / `promotion_rules`). */
export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    description: varchar("description", { length: 1000 }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<PromotionStatus>()
      .notNull(),
    /** SHA-256 hex of the normalized multi-use promo code; never the code. */
    codeHash: varchar("code_hash", { length: 64 }),
    voucherRequired: boolean("voucher_required").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    conditions: jsonb("conditions").$type<PromotionCondition[]>().notNull(),
    benefit: jsonb("benefit").$type<PromotionBenefit>().notNull(),
    stackGroup: varchar("stack_group", { length: 30 }).notNull(),
    stackable: boolean("stackable").notNull(),
    priority: integer("priority").notNull(),
    quotaTotal: integer("quota_total"),
    quotaPerCustomer: integer("quota_per_customer"),
    budgetIdr: idrColumn("budget_idr"),
    /** Atomic counters, changed only by redeem/release (never by the client). */
    spentIdr: idrColumn("spent_idr")
      .notNull()
      .default(sql`0`),
    usesTotal: integer("uses_total").notNull().default(0),
    /** legend-jh27: `all_except` = opt-out rows, `only` = allowlist rows. */
    outletScope: varchar("outlet_scope", { length: 12 })
      .$type<PromotionOutletScope>()
      .notNull()
      .default("all_except"),
    /**
     * Idempotency key of the Tanya AI TL-15 action request that created this
     * promotion (action_requests.id); null for promotions made by hand. The
     * partial unique index below makes a retried execution reuse the first
     * promotion instead of creating a second one. No FK on purpose: the key is
     * only a replay guard, never a join target.
     */
    aiActionRequestId: uuid("ai_action_request_id"),
    createdBy: text("created_by").$type<UserId>(),
    updatedBy: text("updated_by").$type<UserId>(),
    createdAt,
    updatedAt,
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("promotions_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("promotions_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("promotions_tenant_ai_action_request_key")
      .on(table.tenantId, table.aiActionRequestId)
      .where(sql`${table.aiActionRequestId} IS NOT NULL`),
    uniqueIndex("promotions_tenant_code_hash_key")
      .on(table.tenantId, table.codeHash)
      .where(sql`${table.codeHash} IS NOT NULL`),
    index("promotions_tenant_status_idx").on(
      table.tenantId,
      table.status,
      table.startsAt,
    ),
    check(
      "promotions_status_check",
      sql`${table.status} IN ('draft', 'active', 'paused', 'ended')`,
    ),
    check(
      "promotions_validity_check",
      sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      "promotions_outlet_scope_check",
      sql`${table.outletScope} IN ('all_except', 'only')`,
    ),
    check(
      "promotions_code_hash_check",
      sql`${table.codeHash} IS NULL OR ${table.codeHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "promotions_voucher_code_check",
      sql`NOT ${table.voucherRequired} OR ${table.codeHash} IS NOT NULL`,
    ),
    check(
      "promotions_quota_check",
      sql`(${table.quotaTotal} IS NULL OR ${table.quotaTotal} > 0) AND (${table.quotaPerCustomer} IS NULL OR ${table.quotaPerCustomer} > 0)`,
    ),
    // Race backstop: a counter can never pass its cap or drop below zero.
    check(
      "promotions_uses_check",
      sql`${table.usesTotal} >= 0 AND (${table.quotaTotal} IS NULL OR ${table.usesTotal} <= ${table.quotaTotal})`,
    ),
    check(
      "promotions_budget_check",
      sql`${table.spentIdr} >= 0 AND (${table.budgetIdr} IS NULL OR (${table.budgetIdr} >= 0 AND ${table.spentIdr} <= ${table.budgetIdr}))`,
    ),
  ],
);

/** Uses per customer, for `quotaPerCustomer` (tenant-wide counter). */
export const promotionCustomerUsage = pgTable(
  "promotion_customer_usage",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    promotionId: uuid("promotion_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    uses: integer("uses").notNull().default(0),
    updatedAt,
  },
  (table) => [
    primaryKey({
      name: "promotion_customer_usage_pkey",
      columns: [table.tenantId, table.promotionId, table.customerProfileId],
    }),
    foreignKey({
      name: "promotion_customer_usage_promotion_fk",
      columns: [table.tenantId, table.promotionId],
      foreignColumns: [promotions.tenantId, promotions.id],
    }),
    foreignKey({
      name: "promotion_customer_usage_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    check("promotion_customer_usage_uses_check", sql`${table.uses} >= 0`),
  ],
);

/** Single-use voucher codes (§6.C `vouchers`). */
export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** Null = a value voucher (valueIdr) with no promotion behind it. */
    promotionId: uuid("promotion_id"),
    customerProfileId: uuid("customer_profile_id"),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    source: varchar("source", { length: 20 }).$type<VoucherSource>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<VoucherStatus>()
      .notNull()
      .default("issued"),
    valueIdr: idrColumn("value_idr"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    issuedBy: text("issued_by").$type<UserId>(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedOrderId: ulidInUuid("redeemed_order_id"),
    cancelledReason: varchar("cancelled_reason", { length: 300 }),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("vouchers_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("vouchers_tenant_id_id_key").on(table.tenantId, table.id),
    unique("vouchers_tenant_code_hash_key").on(table.tenantId, table.codeHash),
    foreignKey({
      name: "vouchers_promotion_fk",
      columns: [table.tenantId, table.promotionId],
      foreignColumns: [promotions.tenantId, promotions.id],
    }),
    // Already installed by migration 0207; keep the schema snapshot aligned.
    foreignKey({
      name: "vouchers_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("vouchers_tenant_status_idx").on(
      table.tenantId,
      table.status,
      table.issuedAt,
    ),
    index("vouchers_tenant_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
    ),
    check(
      "vouchers_status_check",
      sql`${table.status} IN ('issued', 'redeemed', 'expired', 'cancelled')`,
    ),
    check(
      "vouchers_source_check",
      sql`${table.source} IN ('promo_code', 'apology', 'birthday', 'referral', 'campaign', 'manual', 'loyalty_reward')`,
    ),
    check(
      "vouchers_code_hash_check",
      sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "vouchers_value_check",
      sql`(${table.promotionId} IS NOT NULL) OR (${table.valueIdr} IS NOT NULL AND ${table.valueIdr} > 0)`,
    ),
    check(
      "vouchers_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validUntil} > ${table.validFrom}`,
    ),
    check(
      "vouchers_redeemed_check",
      sql`(${table.status} = 'redeemed') = (${table.redeemedAt} IS NOT NULL AND ${table.redeemedOrderId} IS NOT NULL)`,
    ),
    check(
      "vouchers_cancelled_check",
      sql`(${table.status} = 'cancelled') = (${table.cancelledReason} IS NOT NULL)`,
    ),
  ],
);

/**
 * Read-only cloud voucher catalog on an edge. Holder and redeemed-order ids
 * stay in the validated payload without customer/order FKs: those aggregates
 * need not be replicated before catalog freshness can be proven. Redemption
 * never reads this table; only the cloud's canonical vouchers carry authority.
 */
export const edgeVoucherCatalog = pgTable(
  "edge_voucher_catalog",
  {
    id: uuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    payload: jsonb("payload").$type<VoucherSyncRecord>().notNull(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("edge_voucher_catalog_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
  ],
);

/**
 * What one order consumed (header): the authoritative application result and
 * the fingerprint of the request that produced it, so a retried redeem returns
 * the same answer and a different request under the same order is refused.
 */
export const promotionOrderApplications = pgTable(
  "promotion_order_applications",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    channel: varchar("channel", { length: 20 }).$type<PromoChannel>().notNull(),
    customerProfileId: uuid("customer_profile_id"),
    voucherId: uuid("voucher_id"),
    /** Server-priced bill before promotions (ROI revenue input). */
    subtotalIdr: idrColumn("subtotal_idr").notNull(),
    /**
     * Bill value given back by partial refunds (owner Q41, legend-e5it). The
     * bill's spend is `subtotal_idr - refunded_subtotal_idr` (same-day
     * minimum-spend total, Q40).
     */
    refundedSubtotalIdr: idrColumn("refunded_subtotal_idr")
      .notNull()
      .default(sql`0`),
    totalDiscountIdr: idrColumn("total_discount_idr").notNull(),
    /**
     * What the guest actually owed for the goods after promotions at redeem
     * time (`subtotal_idr - total_discount_idr`). Partial refunds can never
     * pay out more than this in total (owner Q41; `refunded_paid_idr` tracks
     * the part already paid out). Null only on rows from before 0042; the
     * refund falls back to the current amounts for those.
     */
    paidIdr: idrColumn("paid_idr"),
    /** Payout already returned by partial refunds (owner Q41). */
    refundedPaidIdr: idrColumn("refunded_paid_idr")
      .notNull()
      .default(sql`0`),
    /**
     * The promotion rules this order redeemed (conditions + benefit only), so
     * a later partial refund rechecks the bill against what it actually
     * bought, not against an edited promotion (owner Q41 snapshot decision).
     */
    rulesSnapshot: jsonb("rules_snapshot").$type<PromotionRuleSnapshot>(),
    result: jsonb("result").$type<PromotionApplicationResult>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<"applied" | "released">()
      .notNull()
      .default("applied"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    redeemedBy: text("redeemed_by").$type<UserId>(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: varchar("release_reason", { length: 300 }),
  },
  (table) => [
    primaryKey({
      name: "promotion_order_applications_pkey",
      columns: [table.tenantId, table.orderId],
    }),
    foreignKey({
      name: "promotion_order_applications_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "promotion_order_applications_voucher_fk",
      columns: [table.tenantId, table.voucherId],
      foreignColumns: [vouchers.tenantId, vouchers.id],
    }),
    check(
      "promotion_order_applications_status_check",
      sql`${table.status} IN ('applied', 'released')`,
    ),
    check(
      "promotion_order_applications_release_check",
      sql`(${table.status} = 'released') = (${table.releasedAt} IS NOT NULL AND ${table.releaseReason} IS NOT NULL)`,
    ),
    check(
      "promotion_order_applications_amount_check",
      sql`${table.subtotalIdr} >= 0 AND ${table.totalDiscountIdr} >= 0 AND ${table.totalDiscountIdr} <= ${table.subtotalIdr}`,
    ),
    check(
      "promotion_order_applications_refund_check",
      sql`${table.refundedSubtotalIdr} >= 0 AND ${table.refundedSubtotalIdr} <= ${table.subtotalIdr}`,
    ),
    // Q41: payouts never exceed what the guest paid for the goods.
    check(
      "promotion_order_applications_refunded_paid_check",
      sql`${table.refundedPaidIdr} >= 0 AND (${table.paidIdr} IS NULL OR ${table.refundedPaidIdr} <= ${table.paidIdr})`,
    ),
    // Same-day spend of one customer at one outlet (Q40, legend-e5it).
    index("promotion_order_applications_customer_day_idx")
      .on(
        table.tenantId,
        table.outletId,
        table.customerProfileId,
        table.redeemedAt,
      )
      .where(sql`${table.customerProfileId} IS NOT NULL`),
  ],
);

/** One applied promotion (or value voucher) on an order: the ROI fact row. */
export const promotionRedemptions = pgTable(
  "promotion_redemptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** Null for a value voucher without a promotion. */
    promotionId: uuid("promotion_id"),
    voucherId: uuid("voucher_id"),
    customerProfileId: uuid("customer_profile_id"),
    discountIdr: idrColumn("discount_idr").notNull(),
    freeItems: jsonb("free_items").$type<PromoFreeItem[]>().notNull(),
    status: varchar("status", { length: 20 })
      .$type<"applied" | "released">()
      .notNull()
      .default("applied"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "promotion_redemptions_application_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [
        promotionOrderApplications.tenantId,
        promotionOrderApplications.orderId,
      ],
    }),
    foreignKey({
      name: "promotion_redemptions_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "promotion_redemptions_promotion_fk",
      columns: [table.tenantId, table.promotionId],
      foreignColumns: [promotions.tenantId, promotions.id],
    }),
    foreignKey({
      name: "promotion_redemptions_voucher_fk",
      columns: [table.tenantId, table.voucherId],
      foreignColumns: [vouchers.tenantId, vouchers.id],
    }),
    uniqueIndex("promotion_redemptions_order_promotion_key")
      .on(table.tenantId, table.orderId, table.promotionId)
      .where(sql`${table.promotionId} IS NOT NULL`),
    uniqueIndex("promotion_redemptions_order_voucher_key")
      .on(table.tenantId, table.orderId, table.voucherId)
      .where(sql`${table.promotionId} IS NULL`),
    index("promotion_redemptions_roi_idx").on(
      table.tenantId,
      table.promotionId,
      table.status,
    ),
    check(
      "promotion_redemptions_target_check",
      sql`${table.promotionId} IS NOT NULL OR ${table.voucherId} IS NOT NULL`,
    ),
    check(
      "promotion_redemptions_status_check",
      sql`${table.status} IN ('applied', 'released')`,
    ),
    check(
      "promotion_redemptions_released_check",
      sql`(${table.status} = 'released') = (${table.releasedAt} IS NOT NULL)`,
    ),
    check(
      "promotion_redemptions_discount_check",
      sql`${table.discountIdr} >= 0`,
    ),
  ],
);

/** Minimum-spend facility access reward (PRD §3.25, contract FacilityReward). */
export const facilityRewards = pgTable(
  "facility_rewards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** The outlet of the order that earned it. */
    outletId: outletIdColumn(() => outlets.id).notNull(),
    promotionId: uuid("promotion_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    facilityProductId: uuid("facility_product_id").notNull(),
    quantity: integer("quantity").notNull(),
    sourceOrderId: ulidInUuid("source_order_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    entitlementId: uuid("entitlement_id"),
    /** Set when the source order is voided (WS-09 revokes the entitlement). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Outlet business date of a same-day minimum-spend reward (owner Q40,
     * legend-e5it): one live reward per promotion, customer, outlet and day.
     * Null for rewards without a minimum-spend condition.
     */
    businessDate: businessDate("business_date"),
  },
  (table) => [
    foreignKey({
      name: "facility_rewards_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "facility_rewards_promotion_fk",
      columns: [table.tenantId, table.promotionId],
      foreignColumns: [promotions.tenantId, promotions.id],
    }),
    foreignKey({
      name: "facility_rewards_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    foreignKey({
      name: "facility_rewards_product_fk",
      columns: [table.tenantId, table.outletId, table.facilityProductId],
      foreignColumns: [
        facilityProducts.tenantId,
        facilityProducts.outletId,
        facilityProducts.id,
      ],
    }),
    uniqueIndex("facility_rewards_order_promotion_key").on(
      table.tenantId,
      table.sourceOrderId,
      table.promotionId,
    ),
    index("facility_rewards_customer_idx").on(
      table.tenantId,
      table.customerProfileId,
    ),
    // Race backstop for "once per day" (Q40): the service also serializes on
    // a per customer/outlet/day advisory lock.
    uniqueIndex("facility_rewards_daily_key")
      .on(
        table.tenantId,
        table.outletId,
        table.promotionId,
        table.customerProfileId,
        table.businessDate,
      )
      .where(
        sql`${table.businessDate} IS NOT NULL AND ${table.revokedAt} IS NULL`,
      ),
    check("facility_rewards_quantity_check", sql`${table.quantity} > 0`),
  ],
);

/**
 * Per-outlet promotion switch (contract PromotionOutlet, bead legend-e5it).
 * PRD §3.21 is silent on per-outlet promotions; the contract reads "an outlet
 * may switch a promotion off", so a promotion with no row for an outlet runs
 * there and `enabled = false` switches it off at that outlet only (existing
 * tenant-wide promotions keep working). Outlet-owned: tenant + outlet RLS.
 */
export const promotionOutlets = pgTable(
  "promotion_outlets",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    promotionId: uuid("promotion_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    enabled: boolean("enabled").notNull(),
    updatedBy: text("updated_by").$type<UserId>(),
    updatedAt,
  },
  (table) => [
    primaryKey({
      name: "promotion_outlets_pkey",
      columns: [table.tenantId, table.promotionId, table.outletId],
    }),
    foreignKey({
      name: "promotion_outlets_promotion_fk",
      columns: [table.tenantId, table.promotionId],
      foreignColumns: [promotions.tenantId, promotions.id],
    }),
    foreignKey({
      name: "promotion_outlets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("promotion_outlets_outlet_idx").on(table.tenantId, table.outletId),
  ],
);

/** Tenant stacking policy ("aturan tumpang tindih", PRD §3.21). */
export const promoSettings = pgTable("promo_settings", {
  syncTxid: syncTxidColumn(),
  tenantId: tenantIdColumn(() => tenants.id)
    .notNull()
    .primaryKey(),
  stackingPolicy: jsonb("stacking_policy")
    .$type<PromoStackingPolicy>()
    .notNull(),
  updatedBy: text("updated_by").$type<UserId>(),
  updatedAt,
});

/**
 * `Idempotency-Key` store for the promo admin commands that create something
 * (createPromotion, issueVoucher; legend-nloi). One row per (tenant, key): the
 * operation and a sha256 fingerprint of the request body detect key reuse with
 * another body (409 IDEMPOTENCY_KEY_REUSED); `response` is replayed. Written
 * in the same transaction as the command, so both commit together. A voucher's
 * one-time plain code is stored sealed (lib/secrets), never in the clear.
 * Tenant RLS in migration 0091.
 */
export const promoCommandIdempotency = pgTable(
  "promo_command_idempotency",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    operation: varchar("operation", { length: 40 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    response: jsonb("response").notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({
      name: "promo_command_idempotency_pkey",
      columns: [table.tenantId, table.key],
    }),
    check(
      "promo_command_idempotency_fingerprint_check",
      sql`${table.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
