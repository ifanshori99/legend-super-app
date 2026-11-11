// Edge-side running ledger of the transaction events an edge node has queued
// toward the cloud (bead legend-kai). Acknowledged queue rows are pruned, so
// the sent totals live here: one row per (tenant, edge node, event name) with
// a count and the rupiah amount, bumped in the SAME transaction that queues
// the event (services/edge-txn-ledger.service.ts). The cloud reconciles its
// received totals against a digest of this table (edge_reconciliation_runs).
// Money is integer rupiah in bigint, never a float.
//
// `edge_txn_ledger_baselines` marks where the ledger starts: the link sequence
// the node had already reached when the ledger was added. Events at or below
// it were sent but never counted, so the cloud skips them when it reconciles.
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for each table
// (edge-txn-ledger.custom.sql).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edgeTxnLedger = pgTable(
  "edge_txn_ledger",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    eventName: varchar("event_name", { length: 255 }).notNull(),
    /** Transaction events of this name queued so far. */
    eventCount: bigint("event_count", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Sum of `transactionAmountIdr` over those events, integer rupiah. */
    amountIdr: bigint("amount_idr", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /**
     * Sum modulo 2^64 of `eventIdentityHash(event id)` over those events: the
     * identity digest that catches a lost event paired with a duplicate when
     * count and amount still agree. Always 0..2^64-1.
     */
    idHashSum: numeric("id_hash_sum", { precision: 20, scale: 0 })
      .notNull()
      .default(sql`0`),
    /** Link sequence of the latest event counted in this row. */
    lastLinkSeq: bigint("last_link_seq", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.edgeNodeId, table.eventName],
    }),
    foreignKey({
      name: "edge_txn_ledger_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check("edge_txn_ledger_event_count_check", sql`${table.eventCount} >= 0`),
    check("edge_txn_ledger_amount_idr_check", sql`${table.amountIdr} >= 0`),
    check(
      "edge_txn_ledger_id_hash_sum_check",
      sql`${table.idHashSum} >= 0 AND ${table.idHashSum} < 18446744073709551616`,
    ),
  ],
);

// Event ids already counted in the ledger (bead legend-4vwaj). The queue row of
// an acknowledged event is pruned, so a second enqueue of the same event id
// would pass the queue's own duplicate check and be counted again. The ledger
// inserts here first (ON CONFLICT DO NOTHING) and only counts a new id.
// Known limit: events sent before the baseline are not in this table.
export const edgeTxnLedgerEvents = pgTable(
  "edge_txn_ledger_events",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    eventId: ulidInUuid("event_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.edgeNodeId, table.eventId],
    }),
    foreignKey({
      name: "edge_txn_ledger_events_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
  ],
);

export const edgeTxnLedgerBaselines = pgTable(
  "edge_txn_ledger_baselines",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    /** Events with link_seq <= this were sent before the ledger existed. */
    fromLinkSeq: bigint("from_link_seq", { mode: "number" })
      .notNull()
      .default(0),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.edgeNodeId] }),
    foreignKey({
      name: "edge_txn_ledger_baselines_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_txn_ledger_baselines_from_link_seq_check",
      sql`${table.fromLinkSeq} >= 0`,
    ),
  ],
);
