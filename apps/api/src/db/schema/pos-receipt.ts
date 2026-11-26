// POS receipts and documents (bead legend-93a, WS-04; PRD v1.7 §3 F11 "Struk &
// Kuitansi", "Nomor Struk Berurutan", §6 C `receipt_sequences`; POS-06,
// POS-07; contract @starter/shared/pos receipts.ts).
//
//   receipt_sequences       one gapless run per (outlet, device) with its own
//                           prefix; `last_number` moves forward only. At most
//                           one CURRENT (not retired) run per device; its
//                           counter lives in exactly one database: the cloud
//                           (edge_node_id/edge_instance_id NULL) or the edge
//                           database named by that pair (legend-zsdd). A
//                           retired run never numbers again.
//   pos_receipts            one receipt per completed sale, allocated in the
//                           sale's transaction. A void flips `status`; the row
//                           and its number stay (POS-06). Never deleted.
//   pos_receipt_links       e-receipt link/QR: only the SHA-256 of the token.
//   pos_receipt_deliveries  print / link / email requests; the raw email is
//                           sealed (lib/secrets) for the worker, the DTO only
//                           carries the masked form.
//   pos_invoices            F11 invoice for event / corporate orders.
//
// (T, O) rules: tenant_id + outlet_id NOT NULL, unique constraints include
// tenant_id, children reference parents through composite (tenant_id, id)
// keys. RLS, append-only and gapless backstops live in pos-receipt.custom.sql.

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
import {
  businessDate,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns";
import type { ReceiptSeries } from "@starter/shared/pos";
import { posOrders } from "./pos-order";
import { outlets, tenants } from "./platform-org";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** legend-yd0h8: why a device run was retired. */
export type ReceiptSequenceRetiredReason =
  "claim_rotated" | "cloud_takeover" | "edge_replaced" | "edge_regressed";

/** `receipt_sequences` (T, E): §6 C, one gapless run per outlet and device. */
export const receiptSequences = pgTable(
  "receipt_sequences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    /** The terminal; the outlet id stands in for a sale without a device. */
    deviceId: uuid("device_id").notNull(),
    prefix: varchar("prefix", { length: 12 }).notNull(),
    /**
     * 1271 F1: who numbers this run. `device` = the outlet edge (or the device
     * offline), `cloud` = the cloud-owned `C` run, `failover` = the `F<n>` run
     * the cloud numbers while the edge is down (never edge-bound). Fixed for
     * the life of the row.
     */
    series: varchar("series", { length: 10 })
      .$type<ReceiptSeries>()
      .notNull()
      .default("device"),
    lastNumber: integer("last_number").notNull().default(0),
    /**
     * legend-zsdd: the edge database that holds this counter. Both NULL = the
     * cloud holds it; both set = edge node + its database instance
     * (edge_nodes.instance_id of the edge's own row).
     */
    edgeNodeId: uuid("edge_node_id"),
    edgeInstanceId: uuid("edge_instance_id"),
    /** Set once: the run is closed and never numbers again. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /**
     * legend-yd0h8: high-water of the counter the bound edge database reported
     * on its device-records pulls. Never decreases; a later lower report means
     * the edge database was restored or cloned.
     */
    edgeReportedNumber: integer("edge_reported_number").notNull().default(0),
    /**
     * legend-yd0h8: cloud arrival time of the report that last raised
     * the high-water; a report not newer than it is stale and skipped. Never
     * goes backwards.
     */
    edgeReportedAt: timestamp("edge_reported_at", { withTimezone: true }),
    /** legend-yd0h8: why the run was retired (audit + regression rate limit). */
    retiredReason: varchar("retired_reason", {
      length: 30,
    }).$type<ReceiptSequenceRetiredReason>(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("receipt_sequences_tenant_id_id_key").on(table.tenantId, table.id),
    // One CURRENT run per device and series (legend-zsdd, 1271 F1); retired
    // runs stay as history. A device has its P-run and its F-run side by side.
    uniqueIndex("receipt_sequences_device_current_key")
      .on(table.tenantId, table.outletId, table.deviceId, table.series)
      .where(sql`${table.retiredAt} IS NULL`),
    // Two terminals of one outlet never print the same number.
    unique("receipt_sequences_prefix_key").on(
      table.tenantId,
      table.outletId,
      table.prefix,
    ),
    foreignKey({
      name: "receipt_sequences_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "receipt_sequences_prefix_check",
      sql`${table.prefix} ~ '^[A-Z0-9]([A-Z0-9-]{0,10}[A-Z0-9])?$'`,
    ),
    check(
      "receipt_sequences_series_check",
      sql`${table.series} IN ('device', 'cloud', 'failover')`,
    ),
    // 1271 F1 (N2): `F1`..`F9999` belongs to the failover series and only to it.
    check(
      "receipt_sequences_failover_prefix_check",
      sql`(${table.series} = 'failover') = (${table.prefix} ~ '^F[0-9]{1,4}$')`,
    ),
    // 1271 F1 (N1): the cloud alone numbers a failover run; it is never edge-bound.
    check(
      "receipt_sequences_failover_cloud_check",
      sql`${table.series} <> 'failover' OR ${table.edgeNodeId} IS NULL`,
    ),
    check(
      "receipt_sequences_last_number_check",
      sql`${table.lastNumber} BETWEEN 0 AND 999999999`,
    ),
    check(
      "receipt_sequences_edge_binding_check",
      sql`(${table.edgeNodeId} IS NULL) = (${table.edgeInstanceId} IS NULL)`,
    ),
    check(
      "receipt_sequences_edge_reported_number_check",
      sql`${table.edgeReportedNumber} BETWEEN 0 AND 999999999`,
    ),
    check(
      "receipt_sequences_retired_reason_check",
      sql`${table.retiredReason} IS NULL OR (${table.retiredAt} IS NOT NULL AND ${table.retiredReason} IN ('claim_rotated','cloud_takeover','edge_replaced','edge_regressed'))`,
    ),
  ],
);

/**
 * POS-07 header frozen when the receipt is issued: a later outlet rename or
 * move never changes a printed / emailed / e-receipt document. Immutable with
 * the row (pos_receipts_retained trigger).
 */
export type PosReceiptOutletSnapshot = {
  outletName: string;
  outletAddress: string;
  legalName: string | null;
  npwpLast4: string | null;
};

/** `pos_receipts` (T, O): POS-06, one receipt per completed sale. */
export const posReceipts = pgTable(
  "pos_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    number: varchar("number", { length: 22 }).notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    status: varchar("status", { length: 10 }).notNull().default("issued"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: varchar("void_reason", { length: 30 }),
    voidedBy: text("voided_by"),
    reprintCount: smallint("reprint_count").notNull().default(0),
    outletSnapshot: jsonb("outlet_snapshot")
      .$type<PosReceiptOutletSnapshot>()
      .notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("pos_receipts_tenant_id_id_key").on(table.tenantId, table.id),
    // One receipt per sale; a reprint reuses it.
    unique("pos_receipts_order_key").on(table.tenantId, table.orderId),
    // POS-06: each ordinal of a device run exists exactly once.
    unique("pos_receipts_sequence_ordinal_key").on(
      table.tenantId,
      table.sequenceId,
      table.sequenceNumber,
    ),
    unique("pos_receipts_number_key").on(
      table.tenantId,
      table.outletId,
      table.number,
    ),
    foreignKey({
      name: "pos_receipts_sequence_fk",
      columns: [table.tenantId, table.sequenceId],
      foreignColumns: [receiptSequences.tenantId, receiptSequences.id],
    }),
    foreignKey({
      name: "pos_receipts_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_receipts_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "pos_receipts_status_check",
      sql`${table.status} IN ('issued', 'voided')`,
    ),
    check(
      "pos_receipts_sequence_number_check",
      sql`${table.sequenceNumber} BETWEEN 1 AND 999999999`,
    ),
    check(
      "pos_receipts_reprint_count_check",
      sql`${table.reprintCount} BETWEEN 0 AND 99`,
    ),
    check(
      "pos_receipts_void_fields_check",
      sql`(${table.status} = 'voided') = (${table.voidedAt} IS NOT NULL AND ${table.voidReason} IS NOT NULL AND ${table.voidedBy} IS NOT NULL)
        AND (${table.status} = 'voided' OR (${table.voidedAt} IS NULL AND ${table.voidReason} IS NULL AND ${table.voidedBy} IS NULL))`,
    ),
    check(
      "pos_receipts_outlet_snapshot_check",
      sql`jsonb_typeof(${table.outletSnapshot}) = 'object'
        AND jsonb_typeof(${table.outletSnapshot} -> 'outletName') = 'string'
        AND jsonb_typeof(${table.outletSnapshot} -> 'outletAddress') = 'string'`,
    ),
    index("pos_receipts_outlet_issued_idx").on(
      table.tenantId,
      table.outletId,
      table.issuedAt,
    ),
  ],
);

/** `pos_receipt_links` (T, O): e-receipt link; the raw token is never stored. */
export const posReceiptLinks = pgTable(
  "pos_receipt_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    receiptId: uuid("receipt_id").notNull(),
    /** SHA-256 hex of the token. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by"),
    createdAt,
  },
  (table) => [
    unique("pos_receipt_links_tenant_id_id_key").on(table.tenantId, table.id),
    unique("pos_receipt_links_token_key").on(table.tenantId, table.tokenHash),
    unique("pos_receipt_links_idempotency_key").on(
      table.tenantId,
      table.receiptId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "pos_receipt_links_receipt_fk",
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [posReceipts.tenantId, posReceipts.id],
    }),
    foreignKey({
      name: "pos_receipt_links_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "pos_receipt_links_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** `pos_receipt_deliveries` (T, O): print / link / email of a document. */
export const posReceiptDeliveries = pgTable(
  "pos_receipt_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    receiptId: uuid("receipt_id").notNull(),
    channel: varchar("channel", { length: 10 }).notNull(),
    status: varchar("status", { length: 10 }).notNull(),
    /** `o***@example.com`; the only form a DTO carries. */
    destinationMasked: varchar("destination_masked", { length: 120 }),
    /** Email only, while queued: sealed address the worker opens to send. */
    destinationSealed: text("destination_sealed"),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    attempts: smallint("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failureReason: varchar("failure_reason", { length: 200 }),
    requestedBy: text("requested_by"),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("pos_receipt_deliveries_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("pos_receipt_deliveries_idempotency_key").on(
      table.tenantId,
      table.receiptId,
      table.idempotencyKey,
      table.channel,
    ),
    foreignKey({
      name: "pos_receipt_deliveries_receipt_fk",
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [posReceipts.tenantId, posReceipts.id],
    }),
    foreignKey({
      name: "pos_receipt_deliveries_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    // WhatsApp is excluded on purpose: it costs money (PRD §3 F11).
    check(
      "pos_receipt_deliveries_channel_check",
      sql`${table.channel} IN ('print', 'link', 'email')`,
    ),
    check(
      "pos_receipt_deliveries_status_check",
      sql`${table.status} IN ('queued', 'sent', 'failed')`,
    ),
    check(
      "pos_receipt_deliveries_sent_check",
      sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`,
    ),
    check(
      "pos_receipt_deliveries_failed_check",
      sql`${table.status} <> 'failed' OR ${table.failureReason} IS NOT NULL`,
    ),
    check(
      "pos_receipt_deliveries_email_check",
      // The sealed address only lives while the email is queued (PII).
      sql`(${table.channel} <> 'email' AND ${table.destinationSealed} IS NULL)
        OR (${table.channel} = 'email' AND (${table.status} <> 'queued' OR ${table.destinationSealed} IS NOT NULL))`,
    ),
    check(
      "pos_receipt_deliveries_attempts_check",
      sql`${table.attempts} BETWEEN 0 AND 20`,
    ),
    index("pos_receipt_deliveries_queue_idx").on(
      table.tenantId,
      table.channel,
      table.status,
    ),
  ],
);

/** `pos_invoices` (T, O): F11 invoice for event and corporate orders. */
export const posInvoices = pgTable(
  "pos_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    receiptId: uuid("receipt_id").notNull(),
    billedToName: varchar("billed_to_name", { length: 150 }).notNull(),
    billedToAddress: varchar("billed_to_address", { length: 300 }).notNull(),
    billedToNpwp: varchar("billed_to_npwp", { length: 25 }),
    dueDate: businessDate("due_date").notNull(),
    notes: varchar("notes", { length: 500 }),
    idempotencyKey: varchar("idempotency_key", { length: 100 }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt,
  },
  (table) => [
    unique("pos_invoices_tenant_id_id_key").on(table.tenantId, table.id),
    unique("pos_invoices_idempotency_key").on(
      table.tenantId,
      table.orderId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "pos_invoices_receipt_fk",
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [posReceipts.tenantId, posReceipts.id],
    }),
    foreignKey({
      name: "pos_invoices_pos_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [posOrders.tenantId, posOrders.orderId],
    }),
    foreignKey({
      name: "pos_invoices_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    index("pos_invoices_order_idx").on(table.tenantId, table.orderId),
  ],
);
