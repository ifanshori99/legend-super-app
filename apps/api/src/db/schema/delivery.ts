// Delivery channel framework (bead legend-5bn3; PRD v1.7 §3.23 "Integrasi
// Ojek Online", F20, D12, §6.G `delivery_channel_orders`). Tables mirror the
// contract DTOs 1:1 (@starter/shared/delivery: deliveryChannelSchema,
// deliveryChannelOrderSchema, deliverySettlementLineSchema); the service
// mappers (services/delivery-store.ts) parse every row with those schemas.
//
// - tenant_id NOT NULL and outlet_id NOT NULL everywhere; tenant + outlet RLS
//   is installed by delivery.custom.sql (migration 0095). Unique constraints
//   include tenant_id; children reference parents through composite
//   (tenant_id, id) foreign keys.
// - Money is BIGINT whole rupiah, as reported by the platform. `net` is never
//   stored: it is `gross - commission` (deliveryNetIdr).
// - `delivery_channel_orders` is unique per (tenant, platform, external order
//   id): a webhook replay is the same row, never a second order.
// - `delivery_channels.store_external_id` is the platform's merchant/store id;
//   the webhook resolves tenant + outlet from it, so it is unique per
//   platform across tenants.
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
  type PgTableExtraConfigValue,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  DeliveryOrderLine,
  DeliveryOrderSource,
  DeliveryOrderStatus,
  DeliveryPlatform,
  DeliveryPlatformSync,
  DeliverySettlementStatus,
  DeliverySyncStatus,
} from "@starter/shared/delivery";
import {
  businessDate,
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";

const PLATFORMS = "('gofood', 'grabfood', 'shopeefood')";

/** `delivery_channels` (T, O): one row per outlet and platform. */
export const deliveryChannels = pgTable(
  "delivery_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    platform: varchar("platform", { length: 20 })
      .$type<DeliveryPlatform>()
      .notNull(),
    /** The platform's merchant/store id; null until the store is linked. */
    storeExternalId: varchar("store_external_id", { length: 100 }),
    /** Platform commission in basis points (1/100 of a percent). */
    commissionRateBps: integer("commission_rate_bps").notNull().default(0),
    isOpen: boolean("is_open").notNull().default(false),
    closedUntil: timestamp("closed_until", { withTimezone: true }),
    closedReason: varchar("closed_reason", { length: 200 }),
    syncStatus: varchar("sync_status", { length: 10 })
      .$type<DeliverySyncStatus>()
      .notNull()
      .default("stale"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncError: varchar("sync_error", { length: 300 }),
    menuItemCount: integer("menu_item_count").notNull().default(0),
    soldOutItemCount: integer("sold_out_item_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("delivery_channels_tenant_id_id_key").on(table.tenantId, table.id),
    unique("delivery_channels_outlet_platform_key").on(
      table.tenantId,
      table.outletId,
      table.platform,
    ),
    // Target of delivery_store_index's foreign key: an index row always
    // names the channel's current store id.
    unique("delivery_channels_store_ref_key").on(
      table.tenantId,
      table.outletId,
      table.platform,
      table.storeExternalId,
    ),
    // The webhook finds the channel by the platform's store id alone.
    uniqueIndex("delivery_channels_store_key")
      .on(table.platform, table.storeExternalId)
      .where(sql`${table.storeExternalId} IS NOT NULL`),
    foreignKey({
      name: "delivery_channels_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "delivery_channels_platform_check",
      sql`${table.platform} IN ${sql.raw(PLATFORMS)}`,
    ),
    check(
      "delivery_channels_sync_status_check",
      sql`${table.syncStatus} IN ('ok', 'stale', 'error')`,
    ),
    check(
      "delivery_channels_commission_check",
      sql`${table.commissionRateBps} BETWEEN 0 AND 10000`,
    ),
    check(
      "delivery_channels_counts_check",
      sql`${table.menuItemCount} >= 0 AND ${table.soldOutItemCount} >= 0`,
    ),
  ],
);

/** `delivery_channel_orders` (T, O): one platform (or manual POS) order. */
export const deliveryChannelOrders = pgTable(
  "delivery_channel_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    platform: varchar("platform", { length: 20 })
      .$type<DeliveryPlatform>()
      .notNull(),
    externalOrderId: varchar("external_order_id", { length: 100 }).notNull(),
    /** Internal order injected to the KDS; null until injected. */
    orderId: ulidInUuid("order_id"),
    /** Pickup number shown on the pickup display; null until injected. */
    pickupNumber: varchar("pickup_number", { length: 30 }),
    status: varchar("status", { length: 12 })
      .$type<DeliveryOrderStatus>()
      .notNull(),
    source: varchar("source", { length: 12 })
      .$type<DeliveryOrderSource>()
      .notNull(),
    grossIdr: idrColumn("gross_idr").notNull(),
    commissionIdr: idrColumn("commission_idr").notNull(),
    /** SHA-256 hex of the raw payload (manual rows: of the typed input). */
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    /**
     * Every webhook payload hash already applied to this order (newest last,
     * capped by the service): a replay of any of them is a duplicate, never a
     * second update.
     */
    seenPayloadHashes: varchar("seen_payload_hashes", { length: 64 })
      .array()
      .notNull()
      .default(sql`'{}'::varchar[]`),
    /** Signed instant of the newest applied webhook; older ones are ignored. */
    lastSignedAt: timestamp("last_signed_at", { withTimezone: true }),
    customerNote: varchar("customer_note", { length: 300 }),
    lines: jsonb("lines").$type<DeliveryOrderLine[]>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Cancelled or rejected instant. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: varchar("close_reason", { length: 300 }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    settledNetIdr: idrColumn("settled_net_idr"),
    /**
     * Platform sync of the latest staff step (legend-r7vxn): `ok` (nothing
     * pending), `retrying` (the platform call had an unknown outcome; the
     * worker sweep resends the stored intent with backoff) or `needs_action`
     * (refused, or retries exhausted: staff must act). Written by the delivery
     * consumer and sweep only; it does not bump `version` (not an order edit).
     */
    platformSyncState: varchar("platform_sync_state", { length: 12 })
      .$type<DeliveryPlatformSync>()
      .notNull()
      .default("ok"),
    /** Stored adapter action of the unsynced step; null when none pending. */
    platformSyncAction: varchar("platform_sync_action", {
      length: 16,
    }).$type<"accept_order" | "update_order" | "cancel_order">(),
    /** Target status of the unsynced step (the adapter reference is `<id>:<status>`). */
    platformSyncStatus: varchar("platform_sync_status", {
      length: 12,
    }).$type<DeliveryOrderStatus>(),
    /** Platform calls made for the stored intent (the consumer's own is the first). */
    platformSyncAttempts: integer("platform_sync_attempts")
      .notNull()
      .default(0),
    /** Next resend instant while `retrying` (also the claim lease); else null. */
    platformSyncNextAt: timestamp("platform_sync_next_at", {
      withTimezone: true,
    }),
    /** Optimistic concurrency: bumped by every write. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("delivery_channel_orders_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("delivery_channel_orders_external_key").on(
      table.tenantId,
      table.platform,
      table.externalOrderId,
    ),
    foreignKey({
      name: "delivery_channel_orders_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "delivery_channel_orders_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    index("delivery_channel_orders_outlet_idx").on(
      table.tenantId,
      table.outletId,
      table.receivedAt,
    ),
    index("delivery_channel_orders_order_idx").on(
      table.tenantId,
      table.orderId,
    ),
    check(
      "delivery_channel_orders_platform_check",
      sql`${table.platform} IN ${sql.raw(PLATFORMS)}`,
    ),
    check(
      "delivery_channel_orders_status_check",
      sql`${table.status} IN ('received', 'accepted', 'preparing', 'ready', 'picked_up', 'delivered', 'cancelled', 'rejected')`,
    ),
    check(
      "delivery_channel_orders_source_check",
      sql`${table.source} IN ('platform', 'manual_pos')`,
    ),
    check(
      "delivery_channel_orders_payload_hash_check",
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "delivery_channel_orders_money_check",
      sql`${table.grossIdr} >= 0 AND ${table.commissionIdr} >= 0 AND ${table.commissionIdr} <= ${table.grossIdr}`,
    ),
    check(
      "delivery_channel_orders_lines_check",
      sql`jsonb_typeof(${table.lines}) = 'array' AND jsonb_array_length(${table.lines}) >= 1`,
    ),
    check(
      "delivery_channel_orders_settled_check",
      sql`(${table.settledAt} IS NULL) = (${table.settledNetIdr} IS NULL)`,
    ),
    check("delivery_channel_orders_version_check", sql`${table.version} >= 1`),
    check(
      "delivery_channel_orders_platform_sync_check",
      sql`${table.platformSyncState} IN ('ok', 'retrying', 'needs_action')
        AND ${table.platformSyncAttempts} >= 0
        AND (${table.platformSyncAction} IS NULL OR ${table.platformSyncAction} IN ('accept_order', 'update_order', 'cancel_order'))
        AND (${table.platformSyncState} <> 'retrying' OR (${table.platformSyncAction} IS NOT NULL AND ${table.platformSyncStatus} IS NOT NULL AND ${table.platformSyncNextAt} IS NOT NULL))`,
    ),
    index("delivery_channel_orders_platform_retry_idx")
      .on(table.tenantId, table.platformSyncNextAt)
      .where(sql`${table.platformSyncState} = 'retrying'`),
  ],
);

/** `delivery_settlement_lines` (T, O): one platform statement line. */
export const deliverySettlementLines = pgTable(
  "delivery_settlement_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    platform: varchar("platform", { length: 20 })
      .$type<DeliveryPlatform>()
      .notNull(),
    externalOrderId: varchar("external_order_id", { length: 100 }).notNull(),
    grossIdr: idrColumn("gross_idr").notNull(),
    commissionIdr: idrColumn("commission_idr").notNull(),
    /** Money actually received from the platform for this order. */
    settledNetIdr: idrColumn("settled_net_idr").notNull(),
    /** Null = `unknown_order` (no internal delivery order matched). */
    deliveryChannelOrderId: uuid("delivery_channel_order_id"),
    status: varchar("status", { length: 14 })
      .$type<DeliverySettlementStatus>()
      .notNull(),
    /** Signed: reported net minus settled net (0 when matched). */
    varianceIdr: idrColumn("variance_idr").notNull(),
    settledOn: businessDate("settled_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("delivery_settlement_lines_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    // A statement imported twice is the same line, not a second one.
    unique("delivery_settlement_lines_statement_key").on(
      table.tenantId,
      table.platform,
      table.externalOrderId,
      table.settledOn,
    ),
    foreignKey({
      name: "delivery_settlement_lines_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "delivery_settlement_lines_order_fk",
      columns: [table.tenantId, table.deliveryChannelOrderId],
      foreignColumns: [
        deliveryChannelOrders.tenantId,
        deliveryChannelOrders.id,
      ],
    }),
    index("delivery_settlement_lines_period_idx").on(
      table.tenantId,
      table.outletId,
      table.platform,
      table.settledOn,
    ),
    check(
      "delivery_settlement_lines_platform_check",
      sql`${table.platform} IN ${sql.raw(PLATFORMS)}`,
    ),
    check(
      "delivery_settlement_lines_status_check",
      sql`${table.status} IN ('matched', 'variance', 'unknown_order')`,
    ),
    check(
      "delivery_settlement_lines_money_check",
      sql`${table.grossIdr} >= 0 AND ${table.commissionIdr} >= 0 AND ${table.commissionIdr} <= ${table.grossIdr} AND ${table.settledNetIdr} >= 0`,
    ),
    check(
      "delivery_settlement_lines_order_link_check",
      sql`(${table.status} = 'unknown_order') = (${table.deliveryChannelOrderId} IS NULL)`,
    ),
  ],
);

/**
 * `delivery_store_index`: the platform webhook knows only the platform's store
 * id, before any tenant context exists (TEN-02), so this index of
 * (platform, store id) -> (tenant, outlet) is readable without one, exactly
 * like `payment_link_tokens` and `tenant_domains`: SELECT is open. The app
 * role cannot write it: a SECURITY DEFINER trigger on `delivery_channels`
 * keeps it in step from the (tenant-checked) channel row (delivery.custom.sql),
 * so no service writes it by hand. It holds ids only, never an amount or a
 * name; the row cascades away with its channel.
 */
export const deliveryStoreIndex = pgTable(
  "delivery_store_index",
  {
    platform: varchar("platform", { length: 20 })
      .$type<DeliveryPlatform>()
      .notNull(),
    storeExternalId: varchar("store_external_id", { length: 100 }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    outletId: uuid("outlet_id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: "delivery_store_index_pkey",
      columns: [table.platform, table.storeExternalId],
    }),
    // One index row per channel; it can only point at a channel of the same
    // tenant AND at that channel's current store id.
    foreignKey({
      name: "delivery_store_index_channel_fk",
      columns: [
        table.tenantId,
        table.outletId,
        table.platform,
        table.storeExternalId,
      ],
      foreignColumns: [
        deliveryChannels.tenantId,
        deliveryChannels.outletId,
        deliveryChannels.platform,
        deliveryChannels.storeExternalId,
      ],
    }).onDelete("cascade"),
    unique("delivery_store_index_channel_key").on(
      table.tenantId,
      table.outletId,
      table.platform,
    ),
    check(
      "delivery_store_index_platform_check",
      sql`${table.platform} IN ${sql.raw(PLATFORMS)}`,
    ),
  ],
);
