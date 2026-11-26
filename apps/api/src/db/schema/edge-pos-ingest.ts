// Cloud-side ledger of the edge cashier shifts and business days the cloud
// mirrored, is still waiting for, or refused (1269 E3, legend-8yqik,
// legend-k0i8). One row per (tenant, kind, aggregate): the replay guard of
// `cashier_shift.closed` and `day.closed` from an edge, and the record of a
// cash movement that came after its shift was mirrored. No FK to the mirrored
// rows: a pending or refused one has none. An `ingested` row never changes
// (edge-pos-ingest.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  businessDate,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgePosIngestKind = "shift" | "day" | "movement";
export type EdgePosIngestState = "pending" | "ingested" | "refused";

export const edgePosIngests = pgTable(
  "edge_pos_ingests",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    kind: varchar("kind", { length: 10 }).$type<EdgePosIngestKind>().notNull(),
    /** Shift id, daily close id or cash movement id of the edge. */
    aggregateId: uuid("aggregate_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    /** The edge event this row was created from (replay guard). */
    eventId: ulidInUuid("event_id").notNull(),
    state: varchar("state", { length: 10 })
      .$type<EdgePosIngestState>()
      .notNull(),
    /** Why it waits or was refused; a code, never payload data. */
    reason: text("reason"),
    /** Business date as the edge recorded it. */
    businessDate: businessDate("business_date").notNull(),
    /**
     * legend-k0i8: the open business date a late shift was posted to, because
     * its own day was already closed in the cloud. NULL when not late.
     */
    lateBusinessDate: businessDate("late_business_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.kind, table.aggregateId] }),
    check(
      "edge_pos_ingests_kind_check",
      sql`${table.kind} IN ('shift', 'day', 'movement')`,
    ),
    check(
      "edge_pos_ingests_state_check",
      sql`${table.state} IN ('pending', 'ingested', 'refused')`,
    ),
    check(
      "edge_pos_ingests_late_check",
      sql`${table.lateBusinessDate} IS NULL OR ${table.lateBusinessDate} > ${table.businessDate}`,
    ),
    index("edge_pos_ingests_state_idx").on(
      table.tenantId,
      table.state,
      table.updatedAt,
    ),
  ],
);
