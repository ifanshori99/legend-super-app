// Cloud-side record of edge <-> cloud transaction reconciliations (bead
// legend-kai). One append-only row per check: the edge digest of what it sent
// up to a link sequence, what the cloud received up to the same sequence, and
// the per-event-name differences. A mismatch is evidence for a supervisor; no
// code path here ever updates or deletes a row, nor changes an order, a
// deferred event or the edge ledger ("jangan sampai rugi").
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for this table
// (edge-reconciliation.custom.sql).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeReconciliationStatus = "ok" | "mismatch" | "behind" | "stale";

/** Per event name totals; the amount is a decimal string (bigint rupiah). */
export type EdgeReconciliationTotals = Record<
  string,
  { count: number; amountIdr: string; idHash: string }
>;

export type EdgeReconciliationDiff = {
  eventName: string;
  edgeCount: number;
  cloudCount: number;
  edgeAmountIdr: string;
  cloudAmountIdr: string;
  /** Decimal strings, 0..2^64-1 (sum of event identity hashes). */
  edgeIdHash: string;
  cloudIdHash: string;
};

export const edgeReconciliationRuns = pgTable(
  "edge_reconciliation_runs",
  {
    id: ulidInUuid("id").notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    /** Watermark window: link sequences (from, through] were compared. */
    fromLinkSeq: bigint("from_link_seq", { mode: "number" })
      .notNull()
      .default(0),
    throughLinkSeq: bigint("through_link_seq", { mode: "number" }).notNull(),
    /** Edge instance (edge_nodes.instance_id) the digest came from. */
    edgeInstanceId: uuid("edge_instance_id"),
    status: varchar("status", { length: 10 })
      .$type<EdgeReconciliationStatus>()
      .notNull(),
    edgeTotals: jsonb("edge_totals")
      .$type<EdgeReconciliationTotals>()
      .notNull(),
    cloudTotals: jsonb("cloud_totals")
      .$type<EdgeReconciliationTotals>()
      .notNull(),
    diffs: jsonb("diffs").$type<EdgeReconciliationDiff[]>().notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Better Auth user id of the operator; null when the edge asked. */
    checkedBy: varchar("checked_by", { length: 36 }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "edge_reconciliation_runs_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    check(
      "edge_reconciliation_runs_status_check",
      sql`${table.status} IN ('ok', 'mismatch', 'behind', 'stale')`,
    ),
    index("edge_reconciliation_runs_node_idx").on(
      table.tenantId,
      table.edgeNodeId,
      table.checkedAt,
    ),
  ],
);
