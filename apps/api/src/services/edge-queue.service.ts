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
//
// `pruneAckedEdgeQueue` (legend-x3lv) deletes acknowledged rows past their
// retention, hourly, on both sides. Pending rows are never touched (and the
// edge_outbound_queue_guard trigger refuses to delete them anyway).
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { parseEdgeHardeningEnv } from "@starter/shared/env";
import {
  catalogRecordUpdatedEvent,
  EDGE_LINK_AGGREGATE,
  EDGE_LINK_DEAD_LETTERED_EVENT,
  edgeLinkDeadLetteredEvent,
} from "@starter/shared/edge";
import {
  eventEnvelopeSchema,
  syncDirectionSchema,
  type SyncDirection,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { tenants } from "../db/schema/platform-org.ts";
import type { EdgeEventKind } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import { queueOrderViolation } from "../edge/conflict.ts";
import {
  hasEdgeEnvelopeSecrets,
  withoutSecretErrorDetail,
} from "../edge/envelope-secrets.ts";
import {
  isReconciledEvent,
  recordSentTransaction,
  transactionAmountIdr,
} from "./edge-txn-ledger.service.ts";

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

/** Aggregate type of the brand-scoped catalog rows the publisher queues. */
const CATALOG_AGGREGATE_TYPE = catalogRecordUpdatedEvent.entry.aggregateType;

/** Placeholders written per INSERT statement (bind parameters stay bounded). */
const PLACEHOLDER_CHUNK = 200;

/**
 * Hold the outlet's brand stable until the caller commits its delivery read.
 * Take this lock before a link cursor lock, matching the publisher's order.
 */
export async function isCatalogDeliveryRefusedTx(
  tx: EdgeTx,
  node: { tenantId: string; outletId: string; edgeNodeId: string },
): Promise<boolean> {
  const outlet = await tx.execute(
    sql`SELECT 1 FROM outlets o JOIN edge_nodes n ON n.tenant_id = o.tenant_id AND n.outlet_id = o.id WHERE o.tenant_id = ${node.tenantId}::uuid AND o.id = ${node.outletId}::uuid AND n.id = ${node.edgeNodeId}::uuid AND n.status = 'active' FOR SHARE OF o`,
  );
  if (!outlet.rows.length) return true;
  return isCatalogRefused(tx, node);
}

/** Caller already holds the outlet lock; safe to re-check under a cursor lock. */
async function isCatalogRefused(
  tx: EdgeTx,
  node: { tenantId: string; outletId: string; edgeNodeId: string },
): Promise<boolean> {
  const refused = await tx.execute(
    sql`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM edge_nodes n JOIN outlets o ON o.tenant_id = n.tenant_id AND o.id = n.outlet_id WHERE n.tenant_id = ${node.tenantId}::uuid AND n.outlet_id = ${node.outletId}::uuid AND n.id = ${node.edgeNodeId}::uuid AND n.status = 'active') OR EXISTS (SELECT 1 FROM edge_catalog_publisher_cursors c JOIN outlets o ON o.tenant_id = c.tenant_id AND o.id = c.outlet_id WHERE c.tenant_id = ${node.tenantId}::uuid AND c.outlet_id = ${node.outletId}::uuid AND c.edge_node_id = ${node.edgeNodeId}::uuid AND (c.blocked_at IS NOT NULL OR c.brand_id <> o.brand_id))`,
  );
  return refused.rows.length > 0;
}

/**
 * Read path (legend-3k41y): hold the outlet stable before checking refusal and
 * through the caller's queue SELECT. Healthy reads take no link cursor lock;
 * refused reads take it and re-check before replacing catalog rows in place.
 */
export async function neutralizeCatalogRowsIfRefused(
  tx: EdgeTx,
  node: { tenantId: string; outletId: string; edgeNodeId: string },
): Promise<number> {
  return neutralizeCatalogRows(tx, node);
}

/**
 * legend-3k41y: a node that is blocked, or whose outlet brand no longer
 * matches the brand its catalog queue was published for, must never receive a
 * catalog row. Run it inside the caller's transaction: it takes the same
 * cursor lock as the enqueue path, re-checks that the node is still refused
 * and changes nothing when it is not. Then every still-pending cloud_to_edge
 * catalog row above the acknowledged cursor is copied whole into
 * edge_link_dead_letters (reason brand_moved) and replaced IN PLACE, on the
 * same link_seq, by a no-op `edge_link.dead_lettered` placeholder (the notice
 * of the edge_to_cloud dead letter, reason brand_moved; the edge applier only
 * lets the receipt and the cursor advance). Nothing is renumbered and no
 * cursor moves, so a row the receiver already applied or acknowledged keeps
 * its slot, and there is never a hole. The placeholder is its own aggregate
 * (the dead event id, sequence 1), so the receiver's per-aggregate ordering
 * holds. Idempotent: placeholders are not catalog rows. Outlet-scoped events
 * are untouched. Returns the number of rows replaced.
 */
export async function neutralizeCatalogRows(
  tx: EdgeTx,
  node: { tenantId: string; outletId: string; edgeNodeId: string },
): Promise<number> {
  if (!(await isCatalogDeliveryRefusedTx(tx, node))) return 0;
  const cursor = await lockSyncCursor(tx, node, "cloud_to_edge");
  if (!(await isCatalogRefused(tx, node))) return 0;
  const where = sql`edge_node_id = ${node.edgeNodeId}::uuid AND direction = 'cloud_to_edge' AND status = 'pending' AND aggregate_type = ${CATALOG_AGGREGATE_TYPE} AND link_seq > ${cursor.acked_out_seq}`;
  const stale = await tx.execute(
    sql`SELECT link_seq, event_id, aggregate_type, aggregate_id, aggregate_sequence, octet_length(event::text) AS bytes, event FROM edge_outbound_queue WHERE ${where} ORDER BY link_seq`,
  );
  if (!stale.rows.length) return 0;
  await tx.execute(
    sql`INSERT INTO edge_link_dead_letters (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, bytes, reason, event) SELECT tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, octet_length(event::text), 'brand_moved', event FROM edge_outbound_queue WHERE ${where} ON CONFLICT DO NOTHING`,
  );
  await tx.execute(sql`SELECT set_config('app.edge_dead_letter', 'on', true)`);
  await tx.execute(sql`DELETE FROM edge_outbound_queue WHERE ${where}`);
  const placeholders = stale.rows.map((row) => {
    const dead = eventEnvelopeSchema.parse(row.event);
    const notice = edgeLinkDeadLetteredEvent.envelopeSchema.parse({
      id: createUlid(),
      tenantId: node.tenantId,
      outletId: node.outletId,
      name: EDGE_LINK_DEAD_LETTERED_EVENT,
      version: 1,
      aggregateType: EDGE_LINK_AGGREGATE,
      aggregateId: dead.id,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${EDGE_LINK_DEAD_LETTERED_EVENT}:${dead.id}`,
      payloadSchemaRef: `${EDGE_LINK_DEAD_LETTERED_EVENT}.v1`,
      payload: {
        eventId: dead.id,
        // Nothing of the withheld catalog row travels (it belongs to another
        // brand now): the full event stays in edge_link_dead_letters.
        eventName: EDGE_LINK_DEAD_LETTERED_EVENT,
        aggregateType: EDGE_LINK_AGGREGATE,
        aggregateId: dead.id,
        aggregateSequence: 1,
        linkSeq: Number(row.link_seq),
        bytes: Number(row.bytes),
        reason: "brand_moved",
      },
    });
    return sql`(${node.tenantId}::uuid, ${node.outletId}::uuid, ${node.edgeNodeId}::uuid, 'cloud_to_edge', ${Number(row.link_seq)}, ${ulidToUuid(notice.id)}::uuid, ${notice.aggregateType}, ${notice.aggregateId}, ${notice.sequence}, 'transaction_event', ${JSON.stringify(notice)}::jsonb)`;
  });
  for (let i = 0; i < placeholders.length; i += PLACEHOLDER_CHUNK)
    await tx.execute(
      sql`INSERT INTO edge_outbound_queue (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, event) VALUES ${sql.join(placeholders.slice(i, i + PLACEHOLDER_CHUNK), sql`, `)}`,
    );
  await tx.execute(sql`SELECT set_config('app.edge_dead_letter', '', true)`);
  return placeholders.length;
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
  // legend-kyie: pin hash material only ever travels edge -> cloud; it is
  // never queued toward an edge node (and from there a device).
  if (direction !== "edge_to_cloud" && hasEdgeEnvelopeSecrets(event))
    throw new CoreError(
      "FORBIDDEN",
      "Pin hash material is never queued toward an edge node",
    );
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
    // legend-btx4d: a dead-lettered event has left the queue but its
    // sequence is used (the cloud counts it too), so it still counts here.
    sql`SELECT GREATEST(
      (SELECT MAX(aggregate_sequence) FROM edge_outbound_queue WHERE edge_node_id = ${input.edgeNodeId}::uuid AND direction = ${direction} AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${event.aggregateId}),
      (SELECT MAX(aggregate_sequence) FROM edge_link_dead_letters WHERE edge_node_id = ${input.edgeNodeId}::uuid AND direction = ${direction} AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${event.aggregateId})
    ) AS last`,
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
  // legend-kai: a transaction event with an unreadable amount is refused here,
  // before anything is queued (fail closed), not after the insert.
  const countsAsSent =
    input.kind === "transaction_event" &&
    direction === "edge_to_cloud" &&
    isReconciledEvent(event.name);
  if (countsAsSent) transactionAmountIdr(event);
  const linkSeq = cursor.next_out_seq + 1;
  const insert = () =>
    tx.execute(
      sql`INSERT INTO edge_outbound_queue (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, event) VALUES (${ids.tenantId}::uuid, ${ids.outletId}::uuid, ${input.edgeNodeId}::uuid, ${direction}, ${linkSeq}, ${eventUuid}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${input.kind}, ${JSON.stringify(event)}::jsonb)`,
    );
  // A failed insert quotes the event (pin hash, salt) in the driver error;
  // it reaches API logs and job output (Codex 160 C2).
  if (hasEdgeEnvelopeSecrets(event))
    await withoutSecretErrorDetail("Edge queue write failed", insert);
  else await insert();
  // legend-kai: the edge ledger of what was sent, in the same transaction.
  if (countsAsSent) await recordSentTransaction(tx, ids, event, linkSeq);
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

/** How often the runtimes prune acknowledged queue rows. */
export const EDGE_QUEUE_PRUNE_INTERVAL_MS = 3_600_000;
const PRUNE_DEFAULT_BATCH_SIZE = 1_000;

export type PruneAckedEdgeQueueResult = {
  deleted: number;
  /** Tenants whose prune failed; the next run retries them. */
  failedTenants: number;
};

/**
 * Deletes `acked` rows of edge_outbound_queue whose `acked_at` is older than
 * the retention (EDGE_QUEUE_ACKED_RETENTION_DAYS, default 7), in batches of
 * `batchSize` (one short transaction each) until none is left. Pending rows
 * are never touched.
 *
 * System job, cross-tenant on the cloud: instead of an RLS-bypassing owner
 * role, it lists the tenants (the tenants table is not tenant-scoped; the
 * credential check reads it the same way) and prunes each one under its own
 * tenant-wide `job` context through withTenant, so RLS keeps applying and a
 * batch can only ever delete the current tenant's rows. One failing tenant
 * does not stop the others.
 *
 * The newest row of each aggregate (tenant, node, direction, aggregate type +
 * id) is never pruned, whatever its age: `enqueueEdgeEvent`'s order check
 * (`queueOrderViolation` lastQueued) and the link store's
 * `defaultLastSequence` read MAX(aggregate_sequence) from this table, so
 * deleting it would turn the next event of a long-lived aggregate into a
 * false sequence gap. Only rows with a newer row of the same aggregate are
 * eligible; the unique (..., aggregate_sequence) key serves that lookup.
 *
 * Dedupe window: `enqueueEdgeEvent` answers "duplicate" from this table, so
 * for a pruned (older than retention, not newest) event id that answer turns
 * into a CONFLICT: its aggregate sequence is not above the kept newest row, so
 * the order check refuses it and it is never queued again. Delivery stays
 * exactly-once regardless: the receivers keep append-only, never-pruned
 * registries by event id (edge_inbound_events per node + direction, and
 * edge_received_events tenant-wide on the cloud), so even an event that did
 * get re-sent would be recorded as a duplicate, not applied twice.
 */
export async function pruneAckedEdgeQueue(
  options: { now?: Date; retentionDays?: number; batchSize?: number } = {},
): Promise<PruneAckedEdgeQueueResult> {
  const now = options.now ?? new Date();
  const retentionDays =
    options.retentionDays ??
    parseEdgeHardeningEnv(process.env).EDGE_QUEUE_ACKED_RETENTION_DAYS;
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? PRUNE_DEFAULT_BATCH_SIZE),
  );
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const tenantRows = await db.select({ id: tenants.id }).from(tenants);
  const result: PruneAckedEdgeQueueResult = { deleted: 0, failedTenants: 0 };
  for (const { id: tenantId } of tenantRows) {
    const context = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "job" }),
      { kind: "tenant" },
    );
    try {
      for (;;) {
        const deleted = await withTenant(db, context, async (tx) => {
          const removed = await tx.execute(
            sql`DELETE FROM edge_outbound_queue WHERE tenant_id = ${tenantId}::uuid AND status = 'acked' AND (tenant_id, edge_node_id, direction, link_seq) IN (SELECT old.tenant_id, old.edge_node_id, old.direction, old.link_seq FROM edge_outbound_queue old WHERE old.tenant_id = ${tenantId}::uuid AND old.status = 'acked' AND old.acked_at < ${cutoff.toISOString()}::timestamptz AND EXISTS (SELECT 1 FROM edge_outbound_queue newer WHERE newer.tenant_id = old.tenant_id AND newer.edge_node_id = old.edge_node_id AND newer.direction = old.direction AND newer.aggregate_type = old.aggregate_type AND newer.aggregate_id = old.aggregate_id AND newer.aggregate_sequence > old.aggregate_sequence) LIMIT ${batchSize})`,
          );
          return removed.rowCount ?? 0;
        });
        result.deleted += deleted;
        if (deleted < batchSize) break;
      }
    } catch {
      result.failedTenants += 1;
    }
  }
  return result;
}
