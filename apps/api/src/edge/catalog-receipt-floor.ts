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
 * SQL predicate: the receipt `receipt` (an alias of edge_inbound_events) was
 * received after the node's floor, or the node has no floor.
 */
export function receiptAfterCatalogFloor(
  receipt: string,
  edgeNodeId: string,
): SQL {
  return sql`COALESCE(${sql.raw(receipt)}.received_at > (SELECT f.watermark::timestamptz FROM edge_pull_checkpoints f WHERE f.edge_node_id = ${edgeNodeId}::uuid AND f.stream = ${CATALOG_RECEIPT_FLOOR_CHECKPOINT}), true)`;
}
