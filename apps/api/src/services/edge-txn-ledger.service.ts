// Edge-side running ledger of the transaction events queued toward the cloud
// (bead legend-kai). Acknowledged queue rows are pruned, so what the edge sent
// is counted here, in the SAME transaction as the queue insert
// (`recordSentTransaction`, called by `enqueueEdgeEvent`). The digest is read
// under the edge_to_cloud cursor row lock, so its ledger totals and its
// `throughLinkSeq` watermark always describe the same instant. The cloud
// compares the digest with what it received up to that watermark
// (services/edge-reconciliation.service.ts).
//
// Money is integer rupiah: BigInt arithmetic only, amounts travel as decimal
// strings, and `transactionAmountIdr` is the single source of truth used by
// BOTH sides, so the two totals cannot drift by a rounding rule.
import { sql } from "drizzle-orm";
import type { EventEnvelope } from "@starter/shared/events";
import { lockSyncCursor, type EdgeTx } from "./edge-queue.service.ts";

export type EdgeTxnNode = {
  tenantId: string;
  outletId: string;
  edgeNodeId: string;
};

export type EdgeTxnDigest = {
  edgeNodeId: string;
  /** The ledger counts events with link_seq in (fromLinkSeq, throughLinkSeq]. */
  fromLinkSeq: number;
  throughLinkSeq: number;
  totals: Record<string, { count: number; amountIdr: string }>;
};

/** Event name -> the payload key that carries its rupiah amount. */
const AMOUNT_KEY_BY_EVENT: Readonly<Record<string, string>> = {
  "order.submitted": "totalIdr",
  "order.paid": "totalIdr",
  "order.voided": "amountIdr",
  "order.refunded": "amountIdr",
};

/**
 * Event names the ledger and the reconciliation count. Only these park in the
 * cloud's edge_deferred_events; stock, attendance, access and QR events do not,
 * so counting them would be a permanent false mismatch.
 */
export function isReconciledEvent(name: string): boolean {
  return Object.hasOwn(AMOUNT_KEY_BY_EVENT, name);
}

/**
 * The rupiah amount a transaction event contributes to the totals. Every
 * event name outside the table above contributes 0. A missing, non-integer,
 * negative or unsafe value throws (fail closed: the event is not queued).
 * Accepts a safe integer or a canonical decimal string (JSON cannot carry an
 * integer beyond 2^53 as a number).
 */
export function transactionAmountIdr(event: EventEnvelope): bigint {
  const key = AMOUNT_KEY_BY_EVENT[event.name];
  if (key === undefined) return 0n;
  const value: unknown = event.payload[key];
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(
    `${event.name} payload.${key} must be a non-negative integer rupiah amount`,
  );
}

/**
 * Count one queued transaction event in the ledger (count + 1, amount +
 * `transactionAmountIdr`, last link sequence). Runs on the caller's
 * transaction, after the queue insert succeeded.
 */
export async function recordSentTransaction(
  tx: EdgeTx,
  node: EdgeTxnNode,
  event: EventEnvelope,
  linkSeq: number,
): Promise<void> {
  const amountIdr = transactionAmountIdr(event).toString();
  await tx.execute(
    sql`INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr, last_link_seq, updated_at) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${node.edgeNodeId}::uuid, ${event.name}, 1, ${amountIdr}::bigint, ${linkSeq}, now()) ON CONFLICT (tenant_id, edge_node_id, event_name) DO UPDATE SET event_count = edge_txn_ledger.event_count + 1, amount_idr = edge_txn_ledger.amount_idr + EXCLUDED.amount_idr, last_link_seq = GREATEST(edge_txn_ledger.last_link_seq, EXCLUDED.last_link_seq), updated_at = now()`,
  );
}

/**
 * What this node has sent so far, as of the watermark `throughLinkSeq` (its
 * edge_to_cloud `next_out_seq`), counting from `fromLinkSeq` (the ledger
 * baseline, 0 when absent). One transaction: the cursor row lock stops a
 * concurrent enqueue between the reads.
 */
export async function buildEdgeTxnDigest(
  tx: EdgeTx,
  node: EdgeTxnNode,
): Promise<EdgeTxnDigest> {
  const cursor = await lockSyncCursor(tx, node, "edge_to_cloud");
  const rows = await tx.execute(
    sql`SELECT event_name, event_count::text AS event_count, amount_idr::text AS amount_idr FROM edge_txn_ledger WHERE tenant_id = ${node.tenantId}::uuid AND edge_node_id = ${node.edgeNodeId}::uuid ORDER BY event_name`,
  );
  // No baseline row = the ledger has counted this node since its first event.
  const baseline = await tx.execute(
    sql`SELECT from_link_seq FROM edge_txn_ledger_baselines WHERE tenant_id = ${node.tenantId}::uuid AND edge_node_id = ${node.edgeNodeId}::uuid`,
  );
  const totals: EdgeTxnDigest["totals"] = {};
  for (const row of rows.rows)
    totals[String(row.event_name)] = {
      count: Number(row.event_count),
      amountIdr: String(row.amount_idr),
    };
  return {
    edgeNodeId: node.edgeNodeId,
    fromLinkSeq: Number(baseline.rows[0]?.from_link_seq ?? 0),
    throughLinkSeq: cursor.next_out_seq,
    totals,
  };
}
