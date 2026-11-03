// Durable link queue between cloud and edge (bead legend-2pi; PRD v1.7 §3 F5
// "Sinkronisasi": "Outbox per arah dengan ID event unik (ULID), idempoten,
// terurut per agregat, dan dapat dilanjutkan setelah putus").
//
// `enqueueEdgeEvent` runs on the CALLER's tenant transaction, next to the
// domain write that produced the event, so the event is queued if and only if
// the domain change commits:
//   - on the edge, the offline queue (edge_to_cloud) for transaction events:
//     the up-sync bead (legend-kai) calls it from its outbox consumer;
//   - on the cloud, the cloud_to_edge stream: order forwarding to the edge
//     (§3 F5 "Pesanan Pelanggan dari Cloud") and master-data down-sync
//     (legend-97p).
// Each event gets the next gap-free link sequence of its node + direction
// (row lock on sync_cursors), the per-aggregate order is enforced
// (conflict.ts `queueOrderViolation`), and re-queueing the same event id is a
// no-op that returns the original sequence (idempotent). After commit a
// NOTIFY wakes the link so an online peer receives it at once; an offline
// queue simply waits and drains on reconnect.
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  syncDirectionSchema,
  type SyncDirection,
} from "@starter/shared/events";
import type * as schema from "../db/schema/index.ts";
import type { EdgeEventKind } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import { queueOrderViolation } from "../edge/conflict.ts";

type Database = NodePgDatabase<typeof schema>;
export type EdgeTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** NOTIFY channel; the payload carries ids only, never event contents. */
export const EDGE_LINK_WAKE_CHANNEL = "legend_edge_link_wakeup";

export type SyncCursorRow = {
  next_out_seq: number;
  acked_out_seq: number;
  received_in_seq: number;
  last_acked_at: Date | null;
};

/** Creates (if needed) and row-locks the cursor of one node + direction. */
export async function lockSyncCursor(
  tx: EdgeTx,
  node: { tenantId: string; outletId: string; edgeNodeId: string },
  direction: SyncDirection,
): Promise<SyncCursorRow> {
  await tx.execute(
    sql`INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${node.edgeNodeId}::uuid, ${direction}) ON CONFLICT DO NOTHING`,
  );
  const result = await tx.execute(
    sql`SELECT next_out_seq, acked_out_seq, received_in_seq, last_acked_at FROM sync_cursors WHERE edge_node_id = ${node.edgeNodeId}::uuid AND direction = ${direction} FOR UPDATE`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Sync cursor not visible in this scope");
  return {
    next_out_seq: Number(row.next_out_seq),
    acked_out_seq: Number(row.acked_out_seq),
    received_in_seq: Number(row.received_in_seq),
    last_acked_at: (row.last_acked_at as Date | null) ?? null,
  };
}

/** The node row inside the caller's scope (RLS + outlet policy apply). */
async function activeNode(tx: EdgeTx, edgeNodeId: string) {
  const result = await tx.execute(
    sql`SELECT tenant_id, outlet_id, status FROM edge_nodes WHERE id = ${edgeNodeId}::uuid`,
  );
  const row = result.rows[0];
  if (!row || row.status !== "active")
    throw new CoreError("NOT_FOUND", "Edge node tidak ditemukan atau dicabut.");
  return { tenantId: String(row.tenant_id), outletId: String(row.outlet_id) };
}

export type EnqueueEdgeEventInput = {
  edgeNodeId: string;
  direction: SyncDirection;
  kind: EdgeEventKind;
  event: unknown;
};

/**
 * Queue one event for the peer, on the caller's transaction. Returns the
 * link sequence (the original one when this event id was queued before).
 */
export async function enqueueEdgeEvent(
  tx: EdgeTx,
  context: ScopedTenantContext,
  input: EnqueueEdgeEventInput,
): Promise<{ linkSeq: number; duplicate: boolean }> {
  assertTrustedScopedContext(context);
  const direction = syncDirectionSchema.parse(input.direction);
  const event = eventEnvelopeSchema.parse(input.event);
  if (event.tenantId !== context.tenant.tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  const node = await activeNode(tx, input.edgeNodeId);
  // Edge traffic is outlet operational data: a tenant-wide event has no node.
  if (event.outletId !== node.outletId)
    throw new CoreError(
      "CONFLICT",
      "Event outlet does not match the edge node outlet",
    );
  assertOutletInScope(context.outletScope, node.outletId);
  const ids = { ...node, edgeNodeId: input.edgeNodeId };
  const cursor = await lockSyncCursor(tx, ids, direction);
  const eventUuid = ulidToUuid(event.id);
  const existing = await tx.execute(
    sql`SELECT link_seq FROM edge_outbound_queue WHERE edge_node_id = ${input.edgeNodeId}::uuid AND direction = ${direction} AND event_id = ${eventUuid}::uuid`,
  );
  if (existing.rows[0])
    return { linkSeq: Number(existing.rows[0].link_seq), duplicate: true };
  const last = await tx.execute(
    sql`SELECT MAX(aggregate_sequence) AS last FROM edge_outbound_queue WHERE edge_node_id = ${input.edgeNodeId}::uuid AND direction = ${direction} AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${event.aggregateId}`,
  );
  const lastQueued =
    last.rows[0]?.last === null || last.rows[0]?.last === undefined
      ? null
      : Number(last.rows[0].last);
  const violation = queueOrderViolation({
    kind: input.kind,
    direction,
    lastQueued,
    sequence: event.sequence,
  });
  if (violation) throw new CoreError("CONFLICT", violation);
  const linkSeq = cursor.next_out_seq + 1;
  await tx.execute(
    sql`INSERT INTO edge_outbound_queue (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, event) VALUES (${ids.tenantId}::uuid, ${ids.outletId}::uuid, ${input.edgeNodeId}::uuid, ${direction}, ${linkSeq}, ${eventUuid}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${input.kind}, ${JSON.stringify(event)}::jsonb)`,
  );
  await tx.execute(
    sql`UPDATE sync_cursors SET next_out_seq = ${linkSeq}, updated_at = now() WHERE edge_node_id = ${input.edgeNodeId}::uuid AND direction = ${direction}`,
  );
  await tx.execute(
    sql`SELECT pg_notify(${EDGE_LINK_WAKE_CHANNEL}, ${JSON.stringify({ tenantId: ids.tenantId, edgeNodeId: input.edgeNodeId })})`,
  );
  return { linkSeq, duplicate: false };
}

/** Pending (unacknowledged) events and the last acknowledgement time. */
export async function edgeQueueBacklog(
  database: Database,
  context: ScopedTenantContext,
  edgeNodeId: string,
  direction: SyncDirection,
): Promise<{ pending: number; lastAckedAt: Date | null }> {
  return withTenant(database, context, async (tx) => {
    const pending = await tx.execute(
      sql`SELECT COUNT(*)::int AS count FROM edge_outbound_queue WHERE edge_node_id = ${edgeNodeId}::uuid AND direction = ${direction} AND status = 'pending'`,
    );
    const cursor = await tx.execute(
      sql`SELECT last_acked_at FROM sync_cursors WHERE edge_node_id = ${edgeNodeId}::uuid AND direction = ${direction}`,
    );
    const lastAckedAt = cursor.rows[0]?.last_acked_at;
    return {
      pending: Number(pending.rows[0]?.count ?? 0),
      lastAckedAt: lastAckedAt ? new Date(lastAckedAt as string | Date) : null,
    };
  });
}
