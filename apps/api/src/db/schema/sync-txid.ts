// Catalog sync version stamp (bead legend-24318). Every catalog stream table
// carries `sync_txid`: the id of the transaction that last wrote the row,
// stamped by the `app.set_sync_txid` BEFORE INSERT OR UPDATE trigger (the
// trigger itself lives in migration 0262, hand-written SQL). The cloud sends
// only rows older than every still-open transaction and the edge replaces a
// local row only with a strictly newer stamp, so neither a late commit nor an
// out-of-order page can bring older data over newer data. The column default
// stamps existing rows with the migration's own transaction.
import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/** BIGINT read and written as a decimal digit string (never a JS number). */
const bigintText = customType<{ data: string; driverData: string }>({
  dataType: () => "bigint",
});

export const syncTxidColumn = () =>
  bigintText("sync_txid")
    .notNull()
    .default(sql`(pg_current_xact_id()::text)::bigint`);
