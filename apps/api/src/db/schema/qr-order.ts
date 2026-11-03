// QR order: the shared table cart, orders, order items and the guest-mutation
// idempotency ledger (PRD v1.7 §3 F10 "Menu & Keranjang", "Mode Bayar"; §6 C
// `orders` (#10), `order_items` (#11); bead legend-e2x; ORD-01..05, ORD-11).
//
// (T) rules: every table carries tenant_id NOT NULL and outlet_id (all rows are
// outlet-operational), gets enforced tenant + outlet RLS in the generated
// migration (`app.enforce_tenant_rls` / `app.enforce_outlet_rls`), and every
// unique constraint includes tenant_id. Children reference their parents
// through composite (tenant_id, id) keys, so a cart line or order item can
// never point at another tenant's session, menu item or order.
//
// `orders` / `order_items` follow §6 C and are channel-general (POS, captain
// and ojol beads widen the channel check); this bead writes `channel = 'qr'`.
// Money is BIGINT whole rupiah (`idrColumn`); order and item ids are ULIDs
// stored as UUID bytes (D-CORE-1).
//
// The payment link token is sealed (AES-256-GCM, lib/secrets.ts) because the
// WS-05 intent API takes the raw link token; only its hash lives in WS-05.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { idr } from "@starter/shared/core";
import type {
  FireStatus,
  OrderItemStatus,
  PaymentMode,
} from "@starter/shared/qr-order";
import type { TaxCalculationResult } from "@starter/shared/tax";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { menuItems } from "./menu";
import { outlets, tenants } from "./platform-org";
import { sessionParticipants, tableSessions } from "./floor";

/** Snapshot of one chosen modifier (contract cartLineModifierSchema). */
export type CartLineModifierSnapshot = {
  modifierId: string;
  groupId: string;
  name: string;
  priceIdr: number;
};

/** §6 C order status; QR writes awaiting_payment / sent / voided. */
export type OrderStatus =
  "draft" | "awaiting_payment" | "sent" | "completed" | "voided";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** `table_session_carts` (T, O): the one shared cart of a table session. */
export const tableSessionCarts = pgTable(
  "table_session_carts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    /** Optimistic concurrency: every write sends the version it read. */
    version: integer("version").notNull().default(0),
    /**
     * The promo code of the last accepted quote. The checkout contract carries
     * no code, so checkout prices the promotion the guests last quoted.
     */
    promoCode: varchar("promo_code", { length: 40 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("table_session_carts_tenant_id_id_key").on(table.tenantId, table.id),
    unique("table_session_carts_session_key").on(
      table.tenantId,
      table.tableSessionId,
    ),
    foreignKey({
      name: "table_session_carts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "table_session_carts_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    check("table_session_carts_version_check", sql`${table.version} >= 0`),
  ],
);

/** `cart_lines` (T, O): one line of the shared cart, priced by the server. */
export const cartLines = pgTable(
  "cart_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    cartId: uuid("cart_id").notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    variantId: uuid("variant_id"),
    name: varchar("name", { length: 150 }).notNull(),
    quantity: smallint("quantity").notNull(),
    modifiers: jsonb("modifiers")
      .$type<CartLineModifierSnapshot[]>()
      .notNull()
      .default([]),
    note: varchar("note", { length: 200 }),
    /** Channel price resolved by the server when the line was written (ORD-03). */
    unitPriceIdr: idrColumn("unit_price_idr").notNull(),
    modifiersTotalIdr: idrColumn("modifiers_total_idr")
      .notNull()
      .default(idr(0)),
    addedByParticipantId: uuid("added_by_participant_id"),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt,
  },
  (table) => [
    unique("cart_lines_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "cart_lines_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "cart_lines_cart_fk",
      columns: [table.tenantId, table.cartId],
      foreignColumns: [tableSessionCarts.tenantId, tableSessionCarts.id],
    }),
    foreignKey({
      name: "cart_lines_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    foreignKey({
      name: "cart_lines_menu_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    foreignKey({
      name: "cart_lines_participant_fk",
      columns: [table.tenantId, table.addedByParticipantId],
      foreignColumns: [sessionParticipants.tenantId, sessionParticipants.id],
    }),
    index("cart_lines_cart_idx").on(
      table.tenantId,
      table.cartId,
      table.addedAt,
      table.id,
    ),
    check("cart_lines_quantity_check", sql`${table.quantity} BETWEEN 1 AND 99`),
    check("cart_lines_unit_price_check", sql`${table.unitPriceIdr} > 0`),
    check(
      "cart_lines_modifiers_total_check",
      sql`${table.modifiersTotalIdr} >= 0`,
    ),
  ],
);

/** `orders` (T, E): §6 C #10, an order of any channel; QR writes `qr`. */
export const orders = pgTable(
  "orders",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    number: varchar("number", { length: 30 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull(),
    serviceType: varchar("service_type", { length: 20 }).notNull(),
    tableSessionId: uuid("table_session_id"),
    customerProfileId: uuid("customer_profile_id"),
    externalRef: varchar("external_ref", { length: 100 }),
    /** Snapshot of the session's pay mode when the order was placed. */
    paymentMode: varchar("payment_mode", { length: 20 })
      .$type<PaymentMode>()
      .notNull(),
    subtotalIdr: idrColumn("subtotal_idr").notNull(),
    discountIdr: idrColumn("discount_idr").notNull(),
    serviceChargeIdr: idrColumn("service_charge_idr").notNull(),
    taxIdr: idrColumn("tax_idr").notNull(),
    roundingIdr: idrColumn("rounding_idr").notNull(),
    totalIdr: idrColumn("total_idr").notNull(),
    /** Reservation deposit (DP) credit applied to this order (pay-first). */
    depositAppliedIdr: idrColumn("deposit_applied_idr")
      .notNull()
      .default(idr(0)),
    status: varchar("status", { length: 20 }).$type<OrderStatus>().notNull(),
    /** Outlet business date (owner Q39) the daily limits were reserved on. */
    businessDate: businessDate("business_date").notNull(),
    /** The server's tax calculation, kept to record PBJT snapshots on fire. */
    taxResult: jsonb("tax_result").$type<TaxCalculationResult | null>(),
    /** WS-05 payment link opened for a pay-first order (lazily, on pay). */
    paymentLinkId: uuid("payment_link_id"),
    paymentLinkTokenSealed: text("payment_link_token_sealed"),
    /** The one live WS-05 intent for this order (two payers share it). */
    paymentIntentId: uuid("payment_intent_id"),
    note: varchar("note", { length: 200 }),
    /** Staff creator; null for a guest order (§6 C). */
    createdBy: uuid("created_by"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: varchar("void_reason", { length: 100 }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("orders_tenant_id_id_key").on(table.tenantId, table.id),
    unique("orders_tenant_outlet_number_key").on(
      table.tenantId,
      table.outletId,
      table.number,
    ),
    uniqueIndex("orders_tenant_payment_link_key")
      .on(table.tenantId, table.paymentLinkId)
      .where(sql`${table.paymentLinkId} IS NOT NULL`),
    foreignKey({
      name: "orders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "orders_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    index("orders_session_idx").on(
      table.tenantId,
      table.tableSessionId,
      table.placedAt,
    ),
    index("orders_outlet_status_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.placedAt,
    ),
    // Widened to every ORDER_CHANNELS value by the custom migration
    // 0060_posbe_rls (POS, legend-kk7); drizzle's snapshot keeps ('qr'). Edit
    // this check only together with that full list.
    check("orders_channel_check", sql`${table.channel} IN ('qr')`),
    check(
      "orders_service_type_check",
      sql`${table.serviceType} IN ('dine_in', 'takeaway', 'delivery')`,
    ),
    check(
      "orders_status_check",
      sql`${table.status} IN ('draft', 'awaiting_payment', 'sent', 'completed', 'voided')`,
    ),
    check(
      "orders_payment_mode_check",
      sql`${table.paymentMode} IN ('pay_first', 'open_bill')`,
    ),
    check(
      "orders_amounts_check",
      sql`${table.subtotalIdr} >= 0 AND ${table.discountIdr} >= 0 AND ${table.serviceChargeIdr} >= 0 AND ${table.taxIdr} >= 0 AND ${table.totalIdr} >= 0 AND ${table.depositAppliedIdr} >= 0 AND ${table.depositAppliedIdr} <= ${table.totalIdr}`,
    ),
    check(
      "orders_total_check",
      sql`${table.totalIdr} = ${table.subtotalIdr} - ${table.discountIdr} + ${table.serviceChargeIdr} + ${table.taxIdr} + ${table.roundingIdr}`,
    ),
    check(
      "orders_payment_link_pair_check",
      sql`(${table.paymentLinkId} IS NULL) = (${table.paymentLinkTokenSealed} IS NULL)`,
    ),
  ],
);

/** `order_items` (T, E): §6 C #11, one line of an order. */
export const orderItems = pgTable(
  "order_items",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    menuItemId: uuid("menu_item_id").notNull(),
    variantId: uuid("variant_id"),
    name: varchar("name", { length: 150 }).notNull(),
    quantity: smallint("quantity").notNull(),
    unitPriceIdr: idrColumn("unit_price_idr").notNull(),
    modifiersTotalIdr: idrColumn("modifiers_total_idr").notNull(),
    lineTotalIdr: idrColumn("line_total_idr").notNull(),
    modifiers: jsonb("modifiers")
      .$type<CartLineModifierSnapshot[]>()
      .notNull()
      .default([]),
    note: varchar("note", { length: 200 }),
    course: varchar("course", { length: 20 }),
    fireStatus: varchar("fire_status", { length: 20 })
      .$type<FireStatus>()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<OrderItemStatus>()
      .notNull(),
    /**
     * The business date this line reserved its daily limit on. A void releases
     * on this date, exactly once, in the transaction that moves the line to
     * `voided` (menu-availability.ts `releaseMenuItemDailyLimit`).
     */
    reservedBusinessDate: businessDate("reserved_business_date").notNull(),
    voidReason: varchar("void_reason", { length: 100 }),
    voidedBy: uuid("voided_by"),
    voidApprovedBy: uuid("void_approved_by"),
    costSnapshotIdr: idrColumn("cost_snapshot_idr"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("order_items_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "order_items_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "order_items_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "order_items_menu_item_fk",
      columns: [table.tenantId, table.menuItemId],
      foreignColumns: [menuItems.tenantId, menuItems.id],
    }),
    index("order_items_order_idx").on(table.tenantId, table.orderId, table.id),
    check(
      "order_items_quantity_check",
      sql`${table.quantity} BETWEEN 1 AND 99`,
    ),
    check(
      "order_items_line_total_check",
      sql`${table.lineTotalIdr} = (${table.unitPriceIdr} + ${table.modifiersTotalIdr}) * ${table.quantity}`,
    ),
    check(
      "order_items_fire_status_check",
      sql`${table.fireStatus} IN ('held', 'fired')`,
    ),
    check(
      "order_items_status_check",
      sql`${table.status} IN ('queued', 'in_progress', 'ready', 'served', 'voided')`,
    ),
  ],
);

/**
 * `qr_order_idempotency` (T, O): one row per guest mutation key. The key is
 * bound to a request fingerprint (operation + path + body); a replay returns
 * the stored response, a different request with the same key is refused
 * (IDEMPOTENCY_KEY_REUSED).
 */
export const qrOrderIdempotency = pgTable(
  "qr_order_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    operation: varchar("operation", { length: 40 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    response: jsonb("response").$type<unknown>().notNull(),
    createdAt,
  },
  (table) => [
    unique("qr_order_idempotency_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("qr_order_idempotency_key").on(
      table.tenantId,
      table.tableSessionId,
      table.key,
    ),
    foreignKey({
      name: "qr_order_idempotency_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "qr_order_idempotency_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
  ],
);
