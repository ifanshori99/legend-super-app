// Per-order bill splits (bead legend-ms3; docs/briefs/sub-split-bill-design.md
// D2). One order's total is cut into 2+ parts (equal, by item or by person);
// each part is paid through its own payment intent. A re-split voids the live
// set and inserts a new one under a fresh `split_set_id`, so history stays.
//
// Tenant + outlet RLS in `bill-splits.custom.sql`. `payment_intent_id` is a
// plain UUID (no FK): the intent points back with `payment_intents.bill_split_id`
// and a cycle between the two would block inserts. The claim token is stored
// as a SHA-256 hash (lookup) plus an AEAD-sealed copy (shown again to the payer).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  smallint,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import { sessionParticipants, tableSessions } from "./floor";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";

export type BillSplitMethod = "equal" | "by_item" | "by_person";
export type BillSplitStatus = "pending" | "paid" | "voided";

/** `bill_splits` (T, O): one payable part of an order's bill. */
export const billSplits = pgTable(
  "bill_splits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    /** All parts created by one split request share it; a re-split mints a new one. */
    splitSetId: uuid("split_set_id").notNull(),
    method: varchar("method", { length: 20 })
      .$type<BillSplitMethod>()
      .notNull(),
    /** 0-based position inside the set; the remainder goes to the lowest index. */
    shareIndex: smallint("share_index").notNull(),
    amountIdr: idrColumn("amount_idr").notNull(),
    status: varchar("status", { length: 20 })
      .$type<BillSplitStatus>()
      .notNull()
      .default("pending"),
    label: varchar("label", { length: 150 }),
    /** `order_items` ids this part covers (by_item only). */
    itemIds: uuid("item_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    participantId: uuid("participant_id"),
    /** Latest intent minted for this part; plain UUID, no FK (see header). */
    paymentIntentId: uuid("payment_intent_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    /** SHA-256 hex of the raw `sc_` claim token; set when the part is paid. */
    claimTokenHash: varchar("claim_token_hash", { length: 64 }),
    /** The raw token sealed with `sealSecret` so the payer can see it again. */
    claimTokenSealed: text("claim_token_sealed"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    claimRedeemedAt: timestamp("claim_redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("bill_splits_tenant_id_id_key").on(table.tenantId, table.id),
    unique("bill_splits_claim_token_hash_key").on(table.claimTokenHash),
    unique("bill_splits_set_index_key").on(
      table.tenantId,
      table.splitSetId,
      table.shareIndex,
    ),
    // One live part per index per order, whatever set it came from.
    uniqueIndex("bill_splits_live_index_key")
      .on(table.tenantId, table.orderId, table.shareIndex)
      .where(sql`${table.status} <> 'voided'`),
    foreignKey({
      name: "bill_splits_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "bill_splits_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    foreignKey({
      name: "bill_splits_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "bill_splits_participant_fk",
      columns: [table.tenantId, table.participantId],
      foreignColumns: [sessionParticipants.tenantId, sessionParticipants.id],
    }),
    index("bill_splits_session_idx").on(
      table.tenantId,
      table.tableSessionId,
      table.createdAt,
    ),
    check("bill_splits_amount_check", sql`${table.amountIdr} > 0`),
    check(
      "bill_splits_status_check",
      sql`${table.status} IN ('pending', 'paid', 'voided')`,
    ),
    check(
      "bill_splits_method_check",
      sql`${table.method} IN ('equal', 'by_item', 'by_person')`,
    ),
    check(
      "bill_splits_paid_at_check",
      sql`(${table.status} = 'paid') = (${table.paidAt} IS NOT NULL)`,
    ),
    check(
      "bill_splits_voided_at_check",
      sql`(${table.status} = 'voided') = (${table.voidedAt} IS NOT NULL)`,
    ),
    check(
      "bill_splits_by_item_check",
      sql`(${table.method} = 'by_item') = (cardinality(${table.itemIds}) > 0)`,
    ),
    check(
      "bill_splits_by_person_check",
      sql`${table.method} <> 'by_person' OR ${table.participantId} IS NOT NULL`,
    ),
    check(
      "bill_splits_claim_paid_check",
      sql`${table.claimTokenHash} IS NULL OR ${table.status} = 'paid'`,
    ),
    check(
      "bill_splits_claim_redeemed_check",
      sql`${table.claimRedeemedAt} IS NULL OR ${table.claimTokenHash} IS NOT NULL`,
    ),
  ],
);

export type BillSplitRow = typeof billSplits.$inferSelect;
