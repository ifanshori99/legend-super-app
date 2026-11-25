// Deletion markers of the catalog document streams (legend-osqou.22). The cloud
// deletes these rows for good (a floor zone, a table, a cashier default, an
// approval tier, a kitchen rule), so the down-sync announces the deletion with
// a marker. One table for every stream; a new stream only needs the trigger.
//
// `received = false`: written by the AFTER DELETE trigger of the stream's table
// where the row was deleted (the cloud); this is what the export serves.
// `received = true`: the deletion version an edge applied, so an older live
// record that arrives later does not bring the row back.
// Kept apart because an edge's own transaction ids are not comparable with the
// cloud's. RLS, the trigger function and the grants live in migration 0525.
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { TenantId } from "@starter/shared/core";
import type { CatalogDocumentStream } from "@starter/shared/edge";
import { tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";

export const edgeCatalogTombstones = pgTable(
  "edge_catalog_tombstones",
  {
    tenantId: uuid("tenant_id")
      .$type<TenantId>()
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    stream: varchar("stream", { length: 40 })
      .$type<CatalogDocumentStream>()
      .notNull(),
    id: uuid("id").notNull(),
    received: boolean("received").notNull().default(false),
    /** Null for a row the whole tenant shares. No FK: a marker outlives its row. */
    outletId: uuid("outlet_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.stream, table.id, table.received],
    }),
    index("edge_catalog_tombstones_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
  ],
);
