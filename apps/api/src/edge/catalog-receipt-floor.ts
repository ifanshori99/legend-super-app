// Receipt floor of the catalog down-sync (card legend-7r7q6, second opinion
// 1197 finding R1). A link receipt (`edge_inbound_events`) at an old version
// protects an event-backed document from an older HTTP replay. After the cloud
// was restored and the edge rewound, receipts from BEFORE the rewind describe a
// history that no longer exists: they must not hold the catalog on the old
// value. The rewind raises a per-node floor in the checkpoint row below; a
// receipt received at or before the floor no longer counts as held. Receipts
// after the floor protect as usual. No floor row = every receipt counts.
//
// Kept apart from catalog-puller.ts and the link transport: both import this
// module, so it must import neither.
import { sql, type SQL } from "drizzle-orm";

/** Checkpoint row (edge_pull_checkpoints.stream) that holds the floor (ISO UTC). */
export const CATALOG_RECEIPT_FLOOR_CHECKPOINT = "catalog:receipt-floor";

/**
 * Strict ISO UTC shape the floor is written in. Anything else (a hand-edited or
 * corrupt value) is no floor: a bad cast must never break the apply path.
 */
const FLOOR_ISO_PATTERN =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,6})?Z$";

/** SQL scalar: the node's floor as timestamptz, NULL when absent or unreadable. */
export function catalogReceiptFloorValue(edgeNodeId: string): SQL {
  return sql`(SELECT CASE WHEN f.watermark ~ ${FLOOR_ISO_PATTERN} THEN f.watermark::timestamptz END FROM edge_pull_checkpoints f WHERE f.edge_node_id = ${edgeNodeId}::uuid AND f.stream = ${CATALOG_RECEIPT_FLOOR_CHECKPOINT})`;
}

/**
 * SQL predicate: the receipt `receipt` (an alias of edge_inbound_events) was
 * received after the node's floor, or the node has no (readable) floor.
 */
export function receiptAfterCatalogFloor(
  receipt: string,
  edgeNodeId: string,
): SQL {
  return sql`COALESCE(${sql.raw(receipt)}.received_at > ${catalogReceiptFloorValue(edgeNodeId)}, true)`;
}
