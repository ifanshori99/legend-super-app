// Cloud-side ledger of the edge EDC transactions the cloud mirrored into
// `edc_transactions` or refused (1269 E4, legend-osqou.25). One row per
// (tenant, transaction): the replay guard of the `edc_transaction.*` events of
// an edge. `sequence` is the last event applied or refused, `state_hash` the
// mirrored row's changeable fields as the edge last set them, so a row the
// cloud changed itself is never overwritten. No FK to the mirrored row: a
// refused one has none. A refused row is final (edge-edc-ingest.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeEdcIngestState = "ingested" | "refused";

export const edgeEdcIngests = pgTable(
  "edge_edc_ingests",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    /** `edc_transactions.id` of the edge (the event aggregate id). */
    transactionId: uuid("transaction_id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    /** The last event applied (or the one refused). */
    eventId: ulidInUuid("event_id").notNull(),
    /** Its aggregate sequence; never goes down. */
    sequence: integer("sequence").notNull(),
    state: varchar("state", { length: 10 })
      .$type<EdgeEdcIngestState>()
      .notNull(),
    /** Why it was refused; a code, never payload data. */
    reason: text("reason"),
    /** sha256 of the mirrored row's changeable fields; NULL when refused. */
    stateHash: varchar("state_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.transactionId] }),
    check(
      "edge_edc_ingests_state_check",
      sql`${table.state} IN ('ingested', 'refused')`,
    ),
    check("edge_edc_ingests_sequence_check", sql`${table.sequence} > 0`),
    check(
      "edge_edc_ingests_hash_check",
      sql`(${table.state} = 'ingested') = (${table.stateHash} IS NOT NULL)`,
    ),
    index("edge_edc_ingests_state_idx").on(
      table.tenantId,
      table.state,
      table.updatedAt,
    ),
  ],
);
