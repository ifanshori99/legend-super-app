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
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import {
  CoreError,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { withTenant } from "../db/tenant.ts";
import { lockSyncCursor, type EdgeTx } from "./edge-queue.service.ts";

export type EdgeTxnNode = {
  tenantId: string;
  outletId: string;
  edgeNodeId: string;
};

/** Largest value the ledger's bigint columns hold (2^63 - 1). */
export const MAX_LEDGER_BIGINT = 9223372036854775807n;

/** The identity hash sum is kept modulo 2^64 (numeric(20,0) in the ledger). */
export const ID_HASH_MODULUS = 18446744073709551616n;

export type EdgeTxnDigest = {
  edgeNodeId: string;
  /** edge_nodes.instance_id of this edge: the epoch the digest belongs to. */
  edgeInstanceId: string;
  /** The ledger counts events with link_seq in (fromLinkSeq, throughLinkSeq]. */
  fromLinkSeq: number;
  throughLinkSeq: number;
  totals: Record<string, { count: number; amountIdr: string; idHash: string }>;
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
 * negative or unsafe value throws (fail closed: the event is not queued), and
 * so does a value above the bigint range (the ledger column could not hold it).
 * Accepts a safe integer or a canonical decimal string (JSON cannot carry an
 * integer beyond 2^53 as a number).
 */
export function transactionAmountIdr(event: EventEnvelope): bigint {
  const key = AMOUNT_KEY_BY_EVENT[event.name];
  if (key === undefined) return 0n;
  const value: unknown = event.payload[key];
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    // 2^63 and above (also Infinity) is past the bigint range: say so.
    if (value >= 2 ** 63)
      throw new CoreError("VALIDATION_ERROR", "Nilai rupiah melebihi batas.");
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const amount = BigInt(value);
    if (amount > MAX_LEDGER_BIGINT)
      throw new CoreError("VALIDATION_ERROR", "Nilai rupiah melebihi batas.");
    return amount;
  }
  throw new Error(
    `${event.name} payload.${key} must be a non-negative integer rupiah amount`,
  );
}

/**
 * Order-independent identity of one event for the digest: the first 8 bytes
 * (big-endian, unsigned) of sha256 over the canonical UPPERCASE ULID. The
 * ledger and the cloud both sum these per event name modulo 2^64, so a lost
 * event plus a duplicate of another cannot hide behind equal count and amount.
 */
export function eventIdentityHash(eventId: string): bigint {
  const digest = createHash("sha256")
    .update(eventId.toUpperCase(), "utf8")
    .digest();
  return digest.readBigUInt64BE(0);
}

/** Sum of identity hashes modulo 2^64 (the cloud side of the digest). */
export function sumEventIdentityHashes(eventIds: Iterable<string>): bigint {
  let sum = 0n;
  for (const id of eventIds)
    sum = (sum + eventIdentityHash(id)) % ID_HASH_MODULUS;
  return sum;
}

/** SQL 22003 (numeric_value_out_of_range), directly or in drizzle's cause chain. */
function isNumericOutOfRange(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "22003" ||
    isNumericOutOfRange(candidate.cause, depth + 1)
  );
}

/**
 * Count one queued transaction event in the ledger (count + 1, amount +
 * `transactionAmountIdr`, identity hash, last link sequence). Runs on the
 * caller's transaction, after the queue insert succeeded.
 *
 * legend-4vwaj: each event id is recorded once in `edge_txn_ledger_events`
 * first; an id already there was counted before (for example re-enqueued after
 * its acknowledged queue row was pruned) and leaves the ledger untouched.
 * Known limit: events sent before the ledger baseline are not in that table.
 *
 * A cumulative total above the bigint range is refused with a clear error
 * (nothing is queued: the caller's transaction rolls back).
 */
export async function recordSentTransaction(
  tx: EdgeTx,
  node: EdgeTxnNode,
  event: EventEnvelope,
  linkSeq: number,
): Promise<void> {
  const amountIdr = transactionAmountIdr(event).toString();
  const idHash = eventIdentityHash(event.id).toString();
  const fresh = await tx.execute(
    sql`INSERT INTO edge_txn_ledger_events (tenant_id, outlet_id, edge_node_id, event_id) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${node.edgeNodeId}::uuid, ${ulidToUuid(event.id)}::uuid) ON CONFLICT DO NOTHING RETURNING event_id`,
  );
  if (fresh.rows.length === 0) return;
  try {
    await tx.execute(
      sql`INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr, id_hash_sum, last_link_seq, updated_at) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${node.edgeNodeId}::uuid, ${event.name}, 1, ${amountIdr}::bigint, ${idHash}::numeric, ${linkSeq}, now()) ON CONFLICT (tenant_id, edge_node_id, event_name) DO UPDATE SET event_count = edge_txn_ledger.event_count + 1, amount_idr = edge_txn_ledger.amount_idr + EXCLUDED.amount_idr, id_hash_sum = (edge_txn_ledger.id_hash_sum + EXCLUDED.id_hash_sum) % 18446744073709551616, last_link_seq = GREATEST(edge_txn_ledger.last_link_seq, EXCLUDED.last_link_seq), updated_at = now()`,
    );
  } catch (error) {
    if (isNumericOutOfRange(error))
      throw new CoreError("CONFLICT", "Total ledger melebihi batas bigint.");
    throw error;
  }
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
  const instance = await tx.execute(
    sql`SELECT instance_id FROM edge_nodes WHERE id = ${node.edgeNodeId}::uuid`,
  );
  const edgeInstanceId = instance.rows[0]?.instance_id;
  // Fail closed: a digest without an epoch cannot be told apart from a
  // previous instance's, so the cloud could not judge it.
  if (!edgeInstanceId)
    throw new CoreError("CONFLICT", "Edge instance belum diinisialisasi.");
  const rows = await tx.execute(
    sql`SELECT event_name, event_count::text AS event_count, amount_idr::text AS amount_idr, id_hash_sum::text AS id_hash_sum FROM edge_txn_ledger WHERE tenant_id = ${node.tenantId}::uuid AND edge_node_id = ${node.edgeNodeId}::uuid ORDER BY event_name`,
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
      idHash: String(row.id_hash_sum),
    };
  return {
    edgeNodeId: node.edgeNodeId,
    edgeInstanceId: String(edgeInstanceId),
    fromLinkSeq: Number(baseline.rows[0]?.from_link_seq ?? 0),
    throughLinkSeq: cursor.next_out_seq,
    totals,
  };
}

const DEFAULT_DIGEST_LOCK_TIMEOUT_MS = 10_000;

/**
 * legend-1rfy7: `buildEdgeTxnDigest` in its own bounded transaction. The cursor
 * row lock may be held by a local sale, so the build must not wait forever:
 * `lock_timeout` and `statement_timeout` cap every wait, and aborting `signal`
 * cancels the running statement from a second connection so the transaction
 * rolls back and releases its connection and lock queue slot. The cancel is
 * scoped to this transaction's start time, so it cannot hit a later query that
 * reuses the same backend after the rollback.
 */
export async function buildEdgeTxnDigestBounded(
  database: Parameters<typeof withTenant>[0],
  context: ScopedTenantContext,
  node: EdgeTxnNode,
  options: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
): Promise<EdgeTxnDigest> {
  const { signal } = options;
  signal?.throwIfAborted();
  const timeoutMs = Math.max(
    1,
    Math.floor(options.lockTimeoutMs ?? DEFAULT_DIGEST_LOCK_TIMEOUT_MS),
  );
  return withTenant(database, context, async (tx) => {
    const backend = await tx.execute(
      sql`SELECT pg_backend_pid() AS pid, now() AS started_at`,
    );
    const pid = Number(backend.rows[0]?.pid);
    const startedAt = backend.rows[0]?.started_at as Date;
    let live = true;
    // The drizzle node-postgres driver exposes its pool as `$client`. Without
    // it (other drivers) lock_timeout and statement_timeout still bound the wait.
    const cancelPool = (database as unknown as { $client?: Pool }).$client;
    const cancel = () => {
      if (!live || !cancelPool) return;
      void cancelPool
        .query(
          "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND xact_start = $2",
          [pid, startedAt],
        )
        .catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // An abort between statements has nothing to cancel: re-check before work.
      signal?.throwIfAborted();
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${timeoutMs}`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${timeoutMs}`));
      const digest = await buildEdgeTxnDigest(tx, node);
      signal?.throwIfAborted();
      return digest;
    } finally {
      live = false;
      signal?.removeEventListener("abort", cancel);
    }
  });
}
