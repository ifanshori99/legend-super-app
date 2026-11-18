// Edge up-sync reconciliation (bead legend-kai). The edge digest (what it SENT,
// per event name, up to a link sequence watermark; see
// edge-txn-ledger.service.ts `buildEdgeTxnDigest`) is compared with what the
// cloud RECEIVED up to the same watermark.
//
// - cloud totals: edge_inbound_events (edge_to_cloud, transaction_event,
//   link_seq <= watermark) joined to the parked envelope in
//   edge_deferred_events; the amount uses the SAME `transactionAmountIdr` as
//   the edge, with BigInt only.
// - `stale`: the digest's edge instance id differs from the cloud's active
//   epoch (sync_cursors.peer_instance_id), e.g. the edge was rebuilt. The
//   ledger of another instance is not comparable: no totals are compared, so a
//   rebuilt edge is never reported as ok or as a false mismatch. Checked first.
// - `behind`: the cloud cursor (received_in_seq) is below the watermark, so
//   events are still in flight. That is not a mismatch and is never reported
//   as one. Only a cursor at or past the watermark is compared.
// - `mismatch` is a report only. This service writes ONE append-only row in
//   edge_reconciliation_runs and nothing else: no order, deferred event,
//   ledger or money table is touched or corrected ("jangan sampai rugi").
// - Tenant via RLS, outlet via assertOutletInScope on the node's outlet; an
//   unknown or foreign node is NOT_FOUND.
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  toIsoDateTime,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  EDGE_RECONCILED_EVENT_NAMES,
  edgeReconciliationRunSchema,
  edgeTxnDigestSchema,
  type EdgeReconciliationDiff,
  type EdgeReconciliationRun,
  type EdgeReconciliationStatus,
  type EdgeTxnDigest,
  type EdgeTxnTotals,
} from "@starter/shared/edge/reconciliation";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  eventIdentityHash,
  isReconciledEvent,
  transactionAmountIdr,
} from "./edge-txn-ledger.service.ts";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const UINT64_MODULUS = 18446744073709551616n;

const notFound = () => new CoreError("NOT_FOUND", "Edge node tidak ditemukan.");

/** The node's outlet inside the caller's scope (RLS); NOT_FOUND otherwise. */
async function nodeOutletId(
  tx: Tx,
  context: ScopedTenantContext,
  edgeNodeId: string,
): Promise<string> {
  const result = await tx.execute(
    sql`SELECT outlet_id FROM edge_nodes WHERE id = ${edgeNodeId}::uuid`,
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  const outletId = String(row.outlet_id);
  assertOutletInScope(context.outletScope, outletIdSchema.parse(outletId));
  return outletId;
}

/**
 * What the cloud has received up to the watermark, grouped by event name.
 * The cloud stores the edge's link_seq plus `peer_seq_offset` (0 unless the
 * edge was rebuilt), so the edge window (fromLinkSeq, throughLinkSeq] is the
 * cloud window (offset + fromLinkSeq, offset + throughLinkSeq]. `fromLinkSeq`
 * is the edge ledger baseline: events at or below it were sent before the
 * ledger existed and are not in the edge totals, so the cloud skips them too.
 * Only reconciled event names are counted.
 */
async function cloudTotals(
  tx: Tx,
  edgeNodeId: string,
  fromLinkSeq: number,
  throughLinkSeq: number,
  offset: number,
): Promise<EdgeTxnTotals> {
  const result = await tx.execute(
    sql`SELECT d.envelope AS envelope FROM edge_inbound_events i JOIN edge_deferred_events d ON d.tenant_id = i.tenant_id AND d.event_id = i.event_id WHERE i.edge_node_id = ${edgeNodeId}::uuid AND i.direction = 'edge_to_cloud' AND i.kind = 'transaction_event' AND i.link_seq > ${offset + fromLinkSeq} AND i.link_seq <= ${throughLinkSeq + offset}`,
  );
  const counts = new Map<
    string,
    { count: number; amount: bigint; idHash: bigint }
  >();
  for (const row of result.rows) {
    const event = eventEnvelopeSchema.parse(row.envelope);
    if (!isReconciledEvent(event.name)) continue;
    const entry = counts.get(event.name) ?? {
      count: 0,
      amount: 0n,
      idHash: 0n,
    };
    entry.count += 1;
    // Same identity hash as the edge ledger, summed modulo 2^64: a lost event
    // plus a duplicate of another keeps count and amount but not this sum.
    entry.idHash =
      (entry.idHash + eventIdentityHash(event.id)) % UINT64_MODULUS;
    // Fails closed: a malformed money payload stops the run instead of
    // being counted as zero.
    entry.amount += transactionAmountIdr(event);
    counts.set(event.name, entry);
  }
  const totals: EdgeTxnTotals = Object.create(null) as EdgeTxnTotals;
  for (const name of EDGE_RECONCILED_EVENT_NAMES) {
    const entry = counts.get(name);
    if (entry)
      totals[name] = {
        count: entry.count,
        amountIdr: entry.amount.toString(),
        idHash: entry.idHash.toString(),
      };
  }
  return totals;
}

function compareTotals(
  edge: EdgeTxnTotals,
  cloud: EdgeTxnTotals,
): EdgeReconciliationDiff[] {
  const zero = { count: 0, amountIdr: "0", idHash: "0" };
  const diffs: EdgeReconciliationDiff[] = [];
  for (const eventName of EDGE_RECONCILED_EVENT_NAMES) {
    const e = Object.hasOwn(edge, eventName) ? (edge[eventName] ?? zero) : zero;
    const c = Object.hasOwn(cloud, eventName)
      ? (cloud[eventName] ?? zero)
      : zero;
    if (
      e.count === c.count &&
      BigInt(e.amountIdr) === BigInt(c.amountIdr) &&
      BigInt(e.idHash) === BigInt(c.idHash)
    )
      continue;
    diffs.push({
      eventName,
      edgeCount: e.count,
      cloudCount: c.count,
      edgeAmountIdr: BigInt(e.amountIdr).toString(),
      cloudAmountIdr: BigInt(c.amountIdr).toString(),
      edgeIdHash: BigInt(e.idHash).toString(),
      cloudIdHash: BigInt(c.idHash).toString(),
    });
  }
  return diffs;
}

/** JSON with object keys sorted, so jsonb round-trips compare equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

function toRun(row: Record<string, unknown>): EdgeReconciliationRun {
  return edgeReconciliationRunSchema.parse({
    id: uuidToUlid(String(row.id)),
    tenantId: tenantIdSchema.parse(String(row.tenant_id)),
    outletId: String(row.outlet_id),
    edgeNodeId: String(row.edge_node_id),
    fromLinkSeq: Number(row.from_link_seq),
    throughLinkSeq: Number(row.through_link_seq),
    edgeInstanceId:
      row.edge_instance_id === null ? null : String(row.edge_instance_id),
    status: row.status,
    edgeTotals: row.edge_totals,
    cloudTotals: row.cloud_totals,
    diffs: row.diffs,
    // Raw tx.execute returns timestamptz as a string (no driver type parsing).
    checkedAt: toIsoDateTime(new Date(row.checked_at as string | Date)),
    checkedBy: row.checked_by === null ? null : String(row.checked_by),
  });
}

const RUN_COLUMNS = sql.raw(
  "id, tenant_id, outlet_id, edge_node_id, from_link_seq, through_link_seq, edge_instance_id, status, edge_totals, cloud_totals, diffs, checked_at, checked_by",
);

/**
 * Validates an edge digest from an untrusted source. A totals key that is not
 * a reconciled event name ("toString", "__proto__", ...) is refused as a
 * VALIDATION_ERROR: the schema alone drops an own "__proto__" key silently,
 * so own keys are checked first. Never echoes the offending key.
 */
export function parseEdgeTxnDigest(input: unknown): EdgeTxnDigest {
  const totals =
    typeof input === "object" && input !== null
      ? (input as { totals?: unknown }).totals
      : undefined;
  if (typeof totals === "object" && totals !== null) {
    const allowed: readonly string[] = EDGE_RECONCILED_EVENT_NAMES;
    for (const key of Object.keys(totals))
      if (!allowed.includes(key))
        throw new CoreError(
          "VALIDATION_ERROR",
          "Digest memuat jenis event yang tidak direkonsiliasi.",
        );
  }
  const parsed = edgeTxnDigestSchema.safeParse(input);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", "Digest rekonsiliasi tidak valid.");
  return parsed.data;
}

/**
 * Compares the edge digest with the cloud's received totals and appends one
 * run row. Never modifies anything else.
 */
export async function reconcileEdgeTransactions(
  database: Database,
  context: ScopedTenantContext,
  input: { edgeNodeId: string; digest: EdgeTxnDigest; checkedBy?: string },
): Promise<EdgeReconciliationRun> {
  assertTrustedScopedContext(context);
  const digest = parseEdgeTxnDigest(input.digest);
  if (digest.edgeNodeId !== input.edgeNodeId)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Digest bukan milik edge node ini.",
    );
  return withTenant(database, context, async (tx) => {
    const outletId = await nodeOutletId(tx, context, input.edgeNodeId);
    const cursor = await tx.execute(
      sql`SELECT received_in_seq, peer_seq_offset, peer_instance_id::text AS peer_instance_id FROM sync_cursors WHERE edge_node_id = ${input.edgeNodeId}::uuid AND direction = 'edge_to_cloud'`,
    );
    const offset = Number(cursor.rows[0]?.peer_seq_offset ?? 0);
    // received_in_seq is stored in the cloud's numbering; the digest is in the
    // edge's numbering.
    const received = Number(cursor.rows[0]?.received_in_seq ?? 0) - offset;
    // The cloud's active epoch is the edge instance id it last adopted; a NULL
    // epoch or a different instance is stale (fail closed, never compared).
    const peerInstanceId = cursor.rows[0]?.peer_instance_id;
    const stale =
      typeof peerInstanceId !== "string" ||
      peerInstanceId.toLowerCase() !== digest.edgeInstanceId.toLowerCase();
    let status: EdgeReconciliationStatus;
    let cloud: EdgeTxnTotals = {};
    let diffs: EdgeReconciliationDiff[] = [];
    if (stale) {
      status = "stale";
    } else {
      cloud = await cloudTotals(
        tx,
        input.edgeNodeId,
        digest.fromLinkSeq,
        digest.throughLinkSeq,
        offset,
      );
      if (received < digest.throughLinkSeq) {
        status = "behind";
      } else {
        diffs = compareTotals(digest.totals, cloud);
        status = diffs.length === 0 ? "ok" : "mismatch";
      }
    }
    // Scheduled (non-manual) runs are deduplicated: when the latest scheduled
    // run for this node has the same outcome, return it instead of appending
    // an identical row. Manual runs (checkedBy set) always insert. Totals and
    // diffs carry no per-run timestamps, so they are compared whole.
    if (input.checkedBy === undefined || input.checkedBy === null) {
      // Serialize concurrent scheduled reports for one node (an aborted
      // request can still be running when the sender retries), so both cannot
      // read the same "latest" row and insert twice.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"edge-reconciliation:" + input.edgeNodeId}))`,
      );
      const latest = await tx.execute(
        sql`SELECT ${RUN_COLUMNS} FROM edge_reconciliation_runs WHERE tenant_id = ${context.tenant.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND checked_by IS NULL ORDER BY checked_at DESC, id DESC LIMIT 1`,
      );
      if (latest.rows[0]) {
        const previous = toRun(latest.rows[0] as Record<string, unknown>);
        if (
          previous.status === status &&
          previous.fromLinkSeq === digest.fromLinkSeq &&
          previous.throughLinkSeq === digest.throughLinkSeq &&
          previous.edgeInstanceId?.toLowerCase() ===
            digest.edgeInstanceId.toLowerCase() &&
          stableJson(previous.edgeTotals) === stableJson(digest.totals) &&
          stableJson(previous.cloudTotals) === stableJson(cloud) &&
          stableJson(previous.diffs) === stableJson(diffs)
        )
          return previous;
      }
    }
    const id = ulidToUuid(createUlid());
    const inserted = await tx.execute(
      sql`INSERT INTO edge_reconciliation_runs (id, tenant_id, outlet_id, edge_node_id, from_link_seq, through_link_seq, edge_instance_id, status, edge_totals, cloud_totals, diffs, checked_by) VALUES (${id}::uuid, ${context.tenant.tenantId}::uuid, ${outletId}::uuid, ${input.edgeNodeId}::uuid, ${digest.fromLinkSeq}, ${digest.throughLinkSeq}, ${digest.edgeInstanceId}::uuid, ${status}, ${JSON.stringify(digest.totals)}::jsonb, ${JSON.stringify(cloud)}::jsonb, ${JSON.stringify(diffs)}::jsonb, ${input.checkedBy ?? null}) RETURNING ${RUN_COLUMNS}`,
    );
    return toRun(inserted.rows[0] as Record<string, unknown>);
  });
}

/** Newest first. */
export async function listEdgeReconciliationRuns(
  database: Database,
  context: ScopedTenantContext,
  input: { edgeNodeId: string; limit: number },
): Promise<EdgeReconciliationRun[]> {
  assertTrustedScopedContext(context);
  return withTenant(database, context, async (tx) => {
    await nodeOutletId(tx, context, input.edgeNodeId);
    // legend-9z10p: operator (manual) runs must not be pushed out by the
    // automatic ones. Reserve up to half the page for the newest manual runs,
    // fill the rest with the newest automatic runs, then return both newest first.
    const manualRows = await tx.execute(
      sql`SELECT ${RUN_COLUMNS} FROM edge_reconciliation_runs WHERE edge_node_id = ${input.edgeNodeId}::uuid AND checked_by IS NOT NULL ORDER BY checked_at DESC, id DESC LIMIT ${input.limit}`,
    );
    const autoRows = await tx.execute(
      sql`SELECT ${RUN_COLUMNS} FROM edge_reconciliation_runs WHERE edge_node_id = ${input.edgeNodeId}::uuid AND checked_by IS NULL ORDER BY checked_at DESC, id DESC LIMIT ${input.limit}`,
    );
    const newestFirst = (a: EdgeReconciliationRun, b: EdgeReconciliationRun) =>
      a.checkedAt === b.checkedAt
        ? a.id < b.id
          ? 1
          : -1
        : a.checkedAt < b.checkedAt
          ? 1
          : -1;
    const manual = manualRows.rows.map((row) =>
      toRun(row as Record<string, unknown>),
    );
    const auto = autoRows.rows.map((row) =>
      toRun(row as Record<string, unknown>),
    );
    const reserved = Math.floor(input.limit / 2);
    const guaranteed = manual.slice(0, reserved);
    const rest = [...manual.slice(reserved), ...auto]
      .sort(newestFirst)
      .slice(0, input.limit - guaranteed.length);
    return [...guaranteed, ...rest].sort(newestFirst);
  });
}
