// Postgres LinkStore for one edge node's link (bead legend-2pi). The same
// code runs on the cloud (outbound cloud_to_edge, inbound edge_to_cloud) and
// on the edge (the reverse) against that side's database. Every query runs
// inside withTenant with the node's tenant + outlet scope, so RLS and the
// outlet policy bound it even if a filter were missing.
//
// Receive transaction (`applyInbound`): lock the inbound cursor, refuse if it
// moved, then per event: dedupe by event id, classify (receiver-side port),
// decide with conflict.ts, apply through the installed applier, record the
// receipt (and a conflict row with the full envelope when refused), and
// finally advance the cursor. Any failure rolls the whole batch back and no
// ack is sent, so the sender keeps it queued (no loss).
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  type CatalogSyncStream,
  conflictResolution,
  EDGE_LINK_AGGREGATE,
  EDGE_LINK_DEAD_LETTERED_EVENT,
  edgeLinkDeadLetteredEvent,
} from "@starter/shared/edge";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
  type SyncDirection,
} from "@starter/shared/events";
import type * as schema from "../db/schema/index.ts";
import type {
  EdgeConflictResolution,
  EdgeEventKind,
} from "../db/schema/edge-node.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { withTenant } from "../db/tenant.ts";
import {
  notifyEdgeSyncConflictRecorded,
  type NewEdgeSyncConflict,
} from "../services/edge-sync-conflict-alert.ts";
import {
  lockSyncCursor,
  neutralizeCatalogRowsIfRefused,
  type EdgeTx,
} from "../services/edge-queue.service.ts";
import { receiptAfterCatalogFloor } from "./catalog-receipt-floor.ts";
import { decideInbound, type EdgeConflictReason } from "./conflict.ts";
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
import {
  LinkProtocolError,
  type DeadLetterEntry,
  type LinkStore,
  type QueuedEdgeEvent,
} from "./link-peer.ts";
import {
  LINK_RESTORE_PROOF_REFUSAL,
  oppositeDirection,
  restoreProofOf,
} from "./protocol.ts";
import {
  classifyEdgeEvent,
  EdgeApplyDeferredError,
  EdgeEventUnclassifiedError,
  edgeEventApplier,
  type EdgeApplyMeta,
  type EdgeEventApplier,
  type EdgeEventClassifier,
} from "./ports.ts";

type Database = NodePgDatabase<typeof schema>;

/** Parked above any real link_seq while the queue behind a dead letter is renumbered. */
const RENUMBER_PARK = 1_000_000_000_000;

export type DbLinkStoreOptions = {
  database: Database;
  /** Server-minted, scoped to the node's outlet. */
  context: ScopedTenantContext;
  node: { tenantId: string; outletId: string; edgeNodeId: string };
  outboundDirection: SyncDirection;
  /** Sending edge database's instance id (cloud side); null = unknown. */
  edgeInstanceId?: string | null;
  /** Test seams; production uses the installed ports. */
  applier?: EdgeEventApplier<EdgeTx>;
  /** Must return a kind; null/throw refuses the batch (ports.ts, fail closed). */
  classify?: EdgeEventClassifier;
  /** Called once after commit when catalog references need HTTP recovery. */
  onDeferred?: (streams: CatalogSyncStream[]) => void;
};

/**
 * A receipt counts as held when the event was applied, or when it was refused
 * as a conflict and a supervisor later replayed it successfully
 * (edge_sync_conflict_resolutions outcome 'applied', legend-wqc6). Without the
 * second branch the next sequence after a replayed one would be a gap again.
 */
const heldReceipt = (receipt: string) =>
  sql.raw(
    `(${receipt}.outcome = 'applied' OR (${receipt}.outcome = 'conflict' AND EXISTS (SELECT 1 FROM edge_sync_conflicts c JOIN edge_sync_conflict_resolutions r ON r.tenant_id = c.tenant_id AND r.conflict_id = c.id AND r.outcome = 'applied' WHERE c.tenant_id = ${receipt}.tenant_id AND c.edge_node_id = ${receipt}.edge_node_id AND c.direction = ${receipt}.direction AND c.event_id = ${receipt}.event_id)))`,
  );

/** Highest aggregate sequence this side holds for the event's aggregate. */
export async function defaultLastSequence(
  tx: EdgeTx,
  edgeNodeId: string,
  direction: SyncDirection,
  kind: EdgeEventKind,
  event: Pick<EventEnvelope, "aggregateType" | "aggregateId">,
): Promise<number> {
  if (kind === "master_data") {
    // Cloud wins: only what the cloud already sent counts.
    // Receipts from before a catalog rewind (receipt floor, legend-7r7q6) of a
    // catalog record no longer count: the restored cloud history replaces them.
    const afterFloor =
      event.aggregateType === "catalog_record"
        ? sql`AND ${receiptAfterCatalogFloor("i", edgeNodeId)}`
        : sql``;
    const result = await tx.execute(
      sql`SELECT COALESCE(MAX(i.aggregate_sequence), 0) AS last FROM edge_inbound_events i WHERE i.edge_node_id = ${edgeNodeId}::uuid AND i.direction = ${direction} AND i.aggregate_type = ${event.aggregateType} AND i.aggregate_id = ${event.aggregateId} AND ${heldReceipt("i")} ${afterFloor}`,
    );
    return Number(result.rows[0]?.last ?? 0);
  }
  // Append-only stream shared by both sides: an order placed on the cloud
  // (sent down) continues on the edge (sent up), so both directions count.
  // A local dead letter has left the queue, but its aggregate sequence is
  // still used, just as enqueueEdgeEvent treats it when queuing a successor.
  const result = await tx.execute(
    sql`SELECT GREATEST(
      (SELECT COALESCE(MAX(i.aggregate_sequence), 0) FROM edge_inbound_events i WHERE i.edge_node_id = ${edgeNodeId}::uuid AND i.aggregate_type = ${event.aggregateType} AND i.aggregate_id = ${event.aggregateId} AND ${heldReceipt("i")}),
      (SELECT COALESCE(MAX(aggregate_sequence), 0) FROM edge_outbound_queue WHERE edge_node_id = ${edgeNodeId}::uuid AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${event.aggregateId}),
      (SELECT COALESCE(MAX(aggregate_sequence), 0) FROM edge_link_dead_letters WHERE edge_node_id = ${edgeNodeId}::uuid AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${event.aggregateId})
    ) AS last`,
  );
  return Number(result.rows[0]?.last ?? 0);
}

/**
 * A refusal by the domain itself: a CoreError or HttpError that is a client
 * error (4xx). Rate limits and timeouts are transient, so they are not.
 */
export function isDomainRefusal(error: unknown): boolean {
  const status =
    error instanceof CoreError || error instanceof HttpError
      ? error.status
      : null;
  return (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * Runs the applier in a savepoint. A domain refusal or a missing catalog
 * reference rolls back only that event's writes.
 */
async function applyOrRefuse(
  tx: EdgeTx,
  applier: EdgeEventApplier<EdgeTx>,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<
  | { type: "applied" }
  | { type: "deferred"; stream: CatalogSyncStream }
  | { type: "refused"; detail: string }
> {
  try {
    await tx.transaction((savepoint) => applier.apply(savepoint, event, meta));
    return { type: "applied" };
  } catch (error) {
    if (
      error instanceof EdgeApplyDeferredError &&
      meta.kind === "master_data" &&
      meta.direction === "cloud_to_edge"
    )
      return { type: "deferred", stream: error.stream };
    if (!isDomainRefusal(error)) throw error;
    return { type: "refused", detail: (error as Error).message.slice(0, 500) };
  }
}

/** Dead-letter record as read back (legend-btx4d). */
export type StoredDeadLetter = DeadLetterEntry & { readonly createdAt: Date };

/**
 * Widest range `inboundProof` hashes in one call (legend-pz641: it reads the
 * indexed edge_link_slots range, so the cap is higher than when it scanned
 * every receipt). The cloud truncates the proof here; a modern edge accepts
 * any `to` up to its cursor, so a longer prefix is proven over repeated calls.
 */
const RESTORE_PROOF_MAX_SLOTS = 100_000;

export type DbLinkStore = LinkStore &
  Required<Pick<LinkStore, "deadLetterOutbound">> & {
    /** Dead letters of this node and outbound direction, oldest first. */
    listDeadLetters(): Promise<StoredDeadLetter[]>;
  };

export function createDbLinkStore(options: DbLinkStoreOptions): DbLinkStore {
  const { database, context, node } = options;
  assertTrustedScopedContext(context);
  const outbound = options.outboundDirection;
  const inbound = oppositeDirection(outbound);
  const nodeId = node.edgeNodeId;
  const run = <T>(work: (tx: EdgeTx) => Promise<T>) =>
    withTenant(database, context, work);

  /** The sending edge database (cloud side); null = unknown (old edge). */
  const peerInstance = options.edgeInstanceId ?? null;

  /**
   * legend-pz641: claim the stored link slot for a counted receipt. True when
   * the slot now holds this event (new row, or already this event); false
   * when another event holds it. Append-only: a held slot is never changed.
   */
  async function claimSlot(
    tx: EdgeTx,
    storedLinkSeq: number,
    eventUuid: string,
  ): Promise<boolean> {
    const claimed = await tx.execute(
      sql`INSERT INTO edge_link_slots (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${inbound}, ${storedLinkSeq}, ${eventUuid}::uuid) ON CONFLICT DO NOTHING RETURNING 1`,
    );
    if (claimed.rows.length > 0) return true;
    const holder = await tx.execute(
      sql`SELECT event_id FROM edge_link_slots WHERE tenant_id = ${node.tenantId}::uuid AND edge_node_id = ${nodeId}::uuid AND direction = ${inbound} AND link_seq = ${storedLinkSeq}`,
    );
    return (
      String(holder.rows[0]?.event_id ?? "").toLowerCase() ===
      eventUuid.toLowerCase()
    );
  }

  /** applyInbound: a slot held by another event keeps the receipt, logs a warning. */
  async function claimSlotOrWarn(
    tx: EdgeTx,
    storedLinkSeq: number,
    eventUuid: string,
  ) {
    if (await claimSlot(tx, storedLinkSeq, eventUuid)) return;
    logger.warn(
      { edgeNodeId: nodeId, direction: inbound, linkSeq: storedLinkSeq },
      "Link slot already held by another event; receipt kept without the slot",
    );
  }

  /** Whether this node already holds a receipt of the event at that stored slot. */
  async function receiptAt(
    tx: EdgeTx,
    eventUuid: string,
    storedLinkSeq: number,
  ): Promise<boolean> {
    const result = await tx.execute(
      sql`SELECT 1 FROM edge_inbound_events WHERE tenant_id = ${node.tenantId}::uuid AND edge_node_id = ${nodeId}::uuid AND direction = ${inbound} AND event_id = ${eventUuid}::uuid AND link_seq = ${storedLinkSeq}`,
    );
    return result.rows.length > 0;
  }

  /**
   * legend-nd3cu: the link speaks the peer instance's own numbering, which is
   * the stored cursor minus `peer_seq_offset` (0 unless a rebuilt edge
   * database rebased the row). A row already taken over by another instance
   * refuses this link: it is a stale connection of a superseded database.
   */
  async function peerNumbering(tx: EdgeTx, direction: SyncDirection) {
    const result = await tx.execute(
      sql`SELECT next_out_seq, acked_out_seq, received_in_seq, peer_instance_id, peer_seq_offset FROM sync_cursors WHERE edge_node_id = ${nodeId}::uuid AND direction = ${direction}`,
    );
    const row = result.rows[0];
    const instance = (row?.peer_instance_id as string | null) ?? null;
    // A row bound to an edge instance serves only that instance: another
    // one is a stale connection of a superseded database, and a link with no
    // instance (older edge release) would misread the offset.
    if (instance !== null && instance !== peerInstance)
      throw new LinkProtocolError(
        "Link cursor belongs to another edge instance",
      );
    return {
      offset: Number(row?.peer_seq_offset ?? 0),
      next_out_seq: Number(row?.next_out_seq ?? 0),
      acked_out_seq: Number(row?.acked_out_seq ?? 0),
      received_in_seq: Number(row?.received_in_seq ?? 0),
    };
  }

  async function cursorValue(
    column: "next_out_seq" | "acked_out_seq" | "received_in_seq",
    direction: SyncDirection,
  ) {
    return run(async (tx) => {
      const row = await peerNumbering(tx, direction);
      return row[column] - row.offset;
    });
  }

  /**
   * legend-nd3cu: binds both cursor rows of the node to the peer instance on
   * this link, from the peer's hello cursor (link-peer `onPeerHello`).
   * - Same instance: nothing. No instance stored yet (fresh node, or an edge
   *   upgraded in place): adopt it, numbering unchanged.
   * - Same instance or none stored, but a hello cursor below our acknowledged
   *   cloud_to_edge cursor: the database went back in time (restore or
   *   clone, legend-a9iby). Refuse, change nothing. Only seen when the peer
   *   had acknowledged events newer than its backup (docs/deployment.md).
   * - Another instance and cursor 0: a rebuilt database that received nothing
   *   yet. Rebase both directions so its numbering starts at what the cloud
   *   holds: inbound at the received cursor (our hello acknowledges nothing
   *   it has not seen applied; resent events are dropped by their event id),
   *   outbound at the acknowledged cursor (pending events are still sent).
   * - Another instance with a cursor: a restored or cloned database speaking
   *   a numbering we no longer hold. Refuse the link, change nothing (fail
   *   closed; the runbook enrolls it as a new node).
   */
  async function bindPeer(peerCursor: number) {
    if (peerInstance === null) return;
    const instance = peerInstance;
    await run(async (tx) => {
      const directions: SyncDirection[] = ["edge_to_cloud", "cloud_to_edge"];
      const plans: { direction: SyncDirection; offset: number | null }[] = [];
      for (const direction of directions) {
        const cursor = await lockSyncCursor(tx, node, direction);
        const result = await tx.execute(
          sql`SELECT peer_instance_id, peer_seq_offset FROM sync_cursors WHERE edge_node_id = ${nodeId}::uuid AND direction = ${direction}`,
        );
        const stored =
          (result.rows[0]?.peer_instance_id as string | null) ?? null;
        // legend-a9iby: the peer acknowledges only what it applied durably,
        // so its hello cursor never falls below our acknowledged cursor (in
        // its numbering) unless its database went back in time. A restore or
        // clone keeps the instance id, so without this check it would resume,
        // and once its own queue passes our inbound cursor it would take that
        // cursor as an ack for events it created after the restore and never
        // sent. Refuse before anything is written.
        if (
          direction === outbound &&
          (stored === instance || stored === null) &&
          peerCursor <
            cursor.acked_out_seq - Number(result.rows[0]?.peer_seq_offset ?? 0)
        )
          throw new LinkProtocolError(
            "Edge database is older than the cloud's link cursor (restored or cloned); refusing to resume",
          );
        if (stored === instance) continue;
        if (stored !== null && peerCursor !== 0)
          throw new LinkProtocolError(
            "Edge database instance changed with a cursor; refusing to resume",
          );
        // Adopting binds the row for good, so never for a link onHello is
        // about to refuse: a hello cursor beyond our queue (offset 0 here).
        if (
          stored === null &&
          direction === outbound &&
          peerCursor > cursor.next_out_seq
        )
          throw new LinkProtocolError(
            "Peer cursor is ahead of this side's queue; refusing to resume",
          );
        plans.push({
          direction,
          offset:
            stored === null
              ? null
              : direction === inbound
                ? cursor.received_in_seq
                : cursor.acked_out_seq,
        });
      }
      for (const { direction, offset } of plans)
        await tx.execute(
          offset === null
            ? sql`UPDATE sync_cursors SET peer_instance_id = ${instance}::uuid, updated_at = now() WHERE edge_node_id = ${nodeId}::uuid AND direction = ${direction}`
            : sql`UPDATE sync_cursors SET peer_instance_id = ${instance}::uuid, peer_seq_offset = ${offset}, updated_at = now() WHERE edge_node_id = ${nodeId}::uuid AND direction = ${direction}`,
        );
    });
  }

  /**
   * Supervisor alert for a conflict this call just recorded. It runs in a
   * savepoint and never fails the batch: a missing alert must not stop the
   * sync (the conflict row is the durable evidence).
   */
  async function alertNewConflict(tx: EdgeTx, conflict: NewEdgeSyncConflict) {
    try {
      await tx.transaction((savepoint) =>
        notifyEdgeSyncConflictRecorded(savepoint, context, conflict),
      );
    } catch {
      // Intentionally silent: no payload or ids in logs (ports.ts rule).
    }
  }

  /** Records a conflict (idempotent) and alerts only when it is NEW. */
  async function recordConflict(
    tx: EdgeTx,
    input: {
      event: EventEnvelope;
      eventUuid: string;
      kind: EdgeEventKind;
      reason: EdgeConflictReason;
      resolution: EdgeConflictResolution;
      lastSequence: number;
      detail: string | null;
    },
  ) {
    const { event } = input;
    const conflictId = createUlid();
    // legend-kyie: the stored event is readable through the conflict detail
    // API, so pin hash material is stripped first.
    const inserted = await tx.execute(
      sql`INSERT INTO edge_sync_conflicts (id, tenant_id, outlet_id, edge_node_id, direction, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, reason, resolution, existing_sequence, detail, event) VALUES (${ulidToUuid(conflictId)}::uuid, ${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${inbound}, ${input.eventUuid}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${input.kind}, ${input.reason}, ${input.resolution}, ${input.lastSequence}, ${input.detail}, ${JSON.stringify(redactEdgeEnvelopeSecrets(event))}::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
    );
    // Cloud side only (the edge database has no staff to alert), and only
    // when this call really inserted the row (legend-wqc6).
    if (inbound === "edge_to_cloud" && inserted.rows.length > 0)
      await alertNewConflict(tx, {
        id: conflictId,
        tenantId: tenantIdSchema.parse(node.tenantId),
        outletId: outletIdSchema.parse(node.outletId),
        edgeNodeId: nodeId,
        aggregateType: event.aggregateType,
        reason: input.reason,
      });
  }

  // Only the cloud side of a link that names its edge instance settles
  // numbering from the peer's hello; without the hook the peer keeps its
  // original order (old edges, and the edge side, so one side always sends
  // its hello first).
  const resume: Pick<LinkStore, "onPeerHello"> =
    peerInstance === null || outbound !== "cloud_to_edge"
      ? {}
      : { onPeerHello: bindPeer };

  const classify = (event: EventEnvelope): EdgeEventKind => {
    const classifyOption = options.classify;
    if (!classifyOption) return classifyEdgeEvent(event, inbound);
    const kind = classifyOption(event, inbound);
    if (!kind) throw new EdgeEventUnclassifiedError(event.aggregateType);
    return kind;
  };

  return {
    ...resume,
    outboundHead: () => cursorValue("next_out_seq", outbound),
    lastAckedOutbound: () => cursorValue("acked_out_seq", outbound),
    lastReceivedInbound: () => cursorValue("received_in_seq", inbound),

    // legend-tmar2: digest of the event ids in outbound slots (fromSeq, toSeq]
    // in this side's numbering. Acked rows stay in the queue, so the range an
    // acknowledgement would cover can be read back. A missing row (dead
    // letter, wrong database) shows up as a smaller count.
    async outboundProof(fromSeq, toSeq) {
      return run(async (tx) => {
        const { offset } = await peerNumbering(tx, outbound);
        const result = await tx.execute(
          sql`SELECT event_id FROM edge_outbound_queue WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND link_seq > ${fromSeq + offset} AND link_seq <= ${toSeq + offset} ORDER BY link_seq`,
        );
        return restoreProofOf(
          result.rows.map((row) => String(row.event_id).toLowerCase()),
        );
      });
    },

    // legend-tmar2: the same digest over the slots this side holds for the
    // peer's slots (fromSeq, toSeq] (peer numbering; the offset maps them to
    // the stored link_seq). legend-tmar2 (854): fail closed. Proves the
    // longest COMPLETE prefix from+1..from+k of the range (capped at
    // RESTORE_PROOF_MAX_SLOTS slots), each slot held by exactly one event.
    // k=0 gives the empty proof (to=from). Null only when the range is
    // inverted (toSeq < fromSeq).
    // legend-pz641: reads edge_link_slots (primary key range), one row per
    // slot held by a counted receipt (cloud_to_edge always; edge_to_cloud only
    // an event registered in edge_received_events, so a dead-letter receipt
    // holds none). The prefix is found in SQL: link_seq is strictly
    // increasing, so link_seq - from = row number holds exactly up to the
    // first gap. One aggregate row comes back, nothing is pulled into Node.
    async inboundProof(fromSeq, toSeq) {
      if (toSeq < fromSeq) return null;
      const upTo = Math.min(toSeq, fromSeq + RESTORE_PROOF_MAX_SLOTS);
      return run(async (tx) => {
        const { offset } = await peerNumbering(tx, inbound);
        const result = await tx.execute(
          sql`SELECT count(*) AS count, encode(sha256(convert_to(COALESCE(string_agg(p.event_id::text || chr(10), '' ORDER BY p.link_seq), ''), 'UTF8')), 'hex') AS sha256 FROM (SELECT s.link_seq, s.event_id, row_number() OVER (ORDER BY s.link_seq) AS rn FROM edge_link_slots s WHERE s.tenant_id = ${node.tenantId}::uuid AND s.edge_node_id = ${nodeId}::uuid AND s.direction = ${inbound} AND s.link_seq > ${fromSeq + offset} AND s.link_seq <= ${upTo + offset}) p WHERE p.link_seq - ${fromSeq + offset} = p.rn`,
        );
        const row = result.rows[0];
        const length = row ? Number(row.count) : 0;
        if (length === 0) return { to: fromSeq, ...restoreProofOf([]) };
        return {
          to: fromSeq + length,
          count: length,
          sha256: String(row!.sha256),
        };
      });
    },

    async readOutbound(afterSeq, limit) {
      return run(async (tx) => {
        const { offset } = await peerNumbering(tx, outbound);
        // legend-3k41y: fail closed. A node whose catalog publisher is blocked,
        // or whose outlet brand no longer matches the brand its queue was
        // published for, receives no catalog row. An outlet SHARE lock keeps
        // its brand stable through the refusal check and queue SELECT. Healthy
        // reads take no link cursor lock. Only when refused, under that cursor
        // lock (the publisher's enqueue takes the same one), refusal is checked
        // again and every pending catalog row is replaced IN PLACE
        // by a no-op placeholder on its own link slot
        // (neutralizeCatalogRowsIfRefused); only then
        // does the SELECT below run, in the same transaction. No row is
        // renumbered or filtered out of the page, so the receiver's cursor
        // never sees a hole; outlet-scoped events keep flowing.
        if (outbound === "cloud_to_edge")
          await neutralizeCatalogRowsIfRefused(tx, node);
        const result = await tx.execute(
          sql`SELECT link_seq, event FROM edge_outbound_queue WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND link_seq > ${afterSeq + offset} ORDER BY link_seq LIMIT ${limit}`,
        );
        return result.rows.map((row): QueuedEdgeEvent => ({
          linkSeq: Number(row.link_seq) - offset,
          event: eventEnvelopeSchema.parse(row.event),
        }));
      });
    },

    // legend-btx4d: ONE transaction under the cursor lock (the relay that
    // enqueues takes the same lock). The head event is copied whole into the
    // dead-letter table and removed from the queue.
    // - edge_to_cloud: a small `edge_link.dead_lettered` notice (id, aggregate,
    //   sequence, size) takes the SAME link slot. Nothing is renumbered and the
    //   cursor does not move; the cloud meets the notice before any later
    //   event of the same aggregate that is already pending behind it, records
    //   a conflict and counts the dead event's aggregate sequence as used, so
    //   a sale never vanishes without a trace and no sequence_gap follows.
    // - cloud_to_edge: no notice exists for the edge, so the pending rows
    //   behind it (never sent: pump only meets an oversized event at the
    //   head) move down by one together with next_out_seq and the receiver's
    //   contiguous cursor never sees a hole. The queue key is not deferrable,
    //   so the rows are parked far above any sequence first, then brought down.
    //   (A catalog row withheld after a brand move is different: it keeps its
    //   slot and is replaced by a placeholder, neutralizeCatalogRowsIfRefused.)
    async deadLetterOutbound(entry) {
      await run(async (tx) => {
        const cursor = await lockSyncCursor(tx, node, outbound);
        const { offset } = await peerNumbering(tx, outbound);
        const eventUuid = ulidToUuid(entry.event.id);
        const queued = await tx.execute(
          sql`SELECT link_seq, status, aggregate_type, aggregate_id, aggregate_sequence, kind, event FROM edge_outbound_queue WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND event_id = ${eventUuid}::uuid`,
        );
        const row = queued.rows[0];
        // Replay (redelivery, restart): already dead-lettered and gone.
        if (!row) return;
        const storedSeq = Number(row.link_seq);
        if (
          row.status !== "pending" ||
          storedSeq !== entry.linkSeq + offset ||
          storedSeq <= cursor.acked_out_seq
        )
          throw new Error("Dead letter is not the unsent head of the queue");
        await tx.execute(
          sql`INSERT INTO edge_link_dead_letters (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, bytes, reason, event) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${outbound}, ${eventUuid}::uuid, ${storedSeq}, ${row.aggregate_type}, ${row.aggregate_id}, ${row.aggregate_sequence}, ${entry.bytes}, ${entry.reason}, ${JSON.stringify(row.event)}::jsonb) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`SELECT set_config('app.edge_dead_letter', 'on', true)`,
        );
        await tx.execute(
          sql`DELETE FROM edge_outbound_queue WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND link_seq = ${storedSeq}`,
        );
        if (outbound === "edge_to_cloud") {
          const notice = edgeLinkDeadLetteredEvent.envelopeSchema.parse({
            id: createUlid(),
            tenantId: node.tenantId,
            outletId: node.outletId,
            name: EDGE_LINK_DEAD_LETTERED_EVENT,
            version: 1,
            aggregateType: EDGE_LINK_AGGREGATE,
            aggregateId: entry.event.id,
            sequence: 1,
            occurredAt: new Date().toISOString(),
            actor: { type: "system" },
            deviceId: null,
            idempotencyKey: `${EDGE_LINK_DEAD_LETTERED_EVENT}:${entry.event.id}`,
            payloadSchemaRef: `${EDGE_LINK_DEAD_LETTERED_EVENT}.v1`,
            payload: {
              eventId: entry.event.id,
              eventName: entry.event.name,
              aggregateType: String(row.aggregate_type),
              aggregateId: String(row.aggregate_id),
              aggregateSequence: Number(row.aggregate_sequence),
              linkSeq: entry.linkSeq,
              bytes: entry.bytes,
              reason: entry.reason,
            },
          });
          await tx.execute(
            sql`INSERT INTO edge_outbound_queue (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, event) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${outbound}, ${storedSeq}, ${ulidToUuid(notice.id)}::uuid, ${notice.aggregateType}, ${notice.aggregateId}, ${notice.sequence}, 'transaction_event', ${JSON.stringify(notice)}::jsonb)`,
          );
        } else {
          await tx.execute(
            sql`UPDATE edge_outbound_queue SET link_seq = link_seq + ${RENUMBER_PARK} WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND link_seq > ${storedSeq}`,
          );
          await tx.execute(
            sql`UPDATE edge_outbound_queue SET link_seq = link_seq - ${RENUMBER_PARK + 1} WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND link_seq > ${RENUMBER_PARK}`,
          );
          await tx.execute(
            sql`UPDATE sync_cursors SET next_out_seq = next_out_seq - 1, updated_at = now() WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound}`,
          );
        }
        await tx.execute(
          sql`SELECT set_config('app.edge_dead_letter', '', true)`,
        );
      });
    },

    async listDeadLetters() {
      return run(async (tx) => {
        const { offset } = await peerNumbering(tx, outbound);
        const result = await tx.execute(
          sql`SELECT link_seq, bytes, reason, event, created_at FROM edge_link_dead_letters WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} ORDER BY created_at, link_seq`,
        );
        return result.rows.map((row): StoredDeadLetter => ({
          linkSeq: Number(row.link_seq) - offset,
          event: eventEnvelopeSchema.parse(row.event),
          bytes: Number(row.bytes),
          reason: row.reason as DeadLetterEntry["reason"],
          createdAt: row.created_at as Date,
        }));
      });
    },

    async ackOutbound(peerUptoSeq) {
      await run(async (tx) => {
        const cursor = await lockSyncCursor(tx, node, outbound);
        const { offset } = await peerNumbering(tx, outbound);
        const uptoSeq = peerUptoSeq + offset;
        if (uptoSeq > cursor.next_out_seq)
          throw new Error("Acknowledgement beyond the queued sequence");
        if (uptoSeq <= cursor.acked_out_seq) return;
        await tx.execute(
          sql`UPDATE edge_outbound_queue SET status = 'acked', acked_at = now() WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND status = 'pending' AND link_seq <= ${uptoSeq}`,
        );
        await tx.execute(
          sql`UPDATE sync_cursors SET acked_out_seq = ${uptoSeq}, last_acked_at = now(), updated_at = now(), last_event_id = (SELECT event_id FROM edge_outbound_queue WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND link_seq = ${uptoSeq}) WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound}`,
        );
        // PRD §6 A edge_nodes.last_sync_cursor: how far the cloud holds the
        // edge's transactions (edge side records it on acknowledgement).
        if (outbound === "edge_to_cloud")
          await tx.execute(
            sql`UPDATE edge_nodes SET last_sync_cursor = ${String(uptoSeq)}, updated_at = now() WHERE id = ${nodeId}::uuid`,
          );
      });
    },

    // legend-tmar2 (854): cloud side, a modern edge re-sent slots at or below
    // the cursor. Each slot must already hold the same event as a receipt, or
    // the event must be registered as received (a standby re-send, or a hole
    // from a restored database): then the missing receipt is written as
    // 'superseded', closing the hole for inboundProof. Any other event (a
    // different receipt, or one the cloud never saw) means the edge's history
    // diverges from the cloud's: refuse, and the batch is not acknowledged.
    async reconcileReplay({ events }) {
      if (inbound !== "edge_to_cloud" || events.length === 0) return;
      await run(async (tx) => {
        await lockSyncCursor(tx, node, inbound);
        const { offset } = await peerNumbering(tx, inbound);
        const first = events[0]!.linkSeq;
        const last = events[events.length - 1]!.linkSeq;
        // Same rule as inboundProof (R3): a slot is held by the event in
        // edge_link_slots (a counted receipt). A dead-letter receipt holds no
        // slot, so replaying a registered event into that slot writes
        // 'superseded' and claims it.
        const slots = await tx.execute(
          sql`SELECT link_seq, event_id FROM edge_link_slots WHERE tenant_id = ${node.tenantId}::uuid AND edge_node_id = ${nodeId}::uuid AND direction = ${inbound} AND link_seq >= ${Math.min(first, last) + offset} AND link_seq <= ${Math.max(first, last) + offset}`,
        );
        const held = new Map<number, string>();
        for (const row of slots.rows)
          held.set(
            Number(row.link_seq) - offset,
            String(row.event_id).toLowerCase(),
          );
        const skippedInserts: number[] = [];
        for (const { linkSeq, event } of events) {
          const refuse = () =>
            new LinkProtocolError(
              `${LINK_RESTORE_PROOF_REFUSAL} replayed slot ${linkSeq} holds a different event; refusing to resume`,
            );
          if (
            event.tenantId !== node.tenantId ||
            event.outletId !== node.outletId
          )
            throw refuse();
          const eventUuid = ulidToUuid(event.id);
          const holder = held.get(linkSeq);
          if (holder === eventUuid.toLowerCase()) continue;
          if (holder !== undefined) throw refuse();
          const registered = await tx.execute(
            sql`SELECT 1 FROM edge_received_events WHERE tenant_id = ${node.tenantId}::uuid AND event_id = ${eventUuid}::uuid`,
          );
          if (registered.rows.length === 0) throw refuse();
          const inserted = await tx.execute(
            sql`INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${inbound}, ${eventUuid}::uuid, ${linkSeq + offset}, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${classify(event)}, 'superseded') ON CONFLICT DO NOTHING RETURNING 1`,
          );
          // ON CONFLICT DO NOTHING stays (a concurrent insert must not fail
          // the batch). The primary key is (tenant_id, edge_node_id,
          // direction, event_id), with no uniqueness on link_seq, so a
          // conflict means this same registered event already has a receipt:
          // in this very slot (a slot the migration backfill did not fill:
          // claim it) or in another slot (the hole in this slot is not
          // closed by this insert, so it is counted and logged instead of
          // passing silently).
          if (
            inserted.rows.length > 0 ||
            (await receiptAt(tx, eventUuid, linkSeq + offset))
          ) {
            if (!(await claimSlot(tx, linkSeq + offset, eventUuid)))
              throw refuse();
          } else skippedInserts.push(linkSeq);
        }
        if (skippedInserts.length > 0)
          logger.warn(
            {
              edgeNodeId: nodeId,
              direction: inbound,
              skippedSlots: skippedInserts.length,
              firstSkippedSlot: skippedInserts[0],
            },
            `Replay reconcile skipped ${skippedInserts.length} receipt insert(s) on conflict`,
          );
      });
    },

    async applyInbound({ fromSeq, toSeq, events }) {
      const deferredStreams = new Set<CatalogSyncStream>();
      const applier: EdgeEventApplier<EdgeTx> =
        options.applier ?? edgeEventApplier(inbound);
      await run(async (tx) => {
        const cursor = await lockSyncCursor(tx, node, inbound);
        const { offset } = await peerNumbering(tx, inbound);
        if (cursor.received_in_seq !== fromSeq + offset)
          throw new Error("Inbound cursor moved; batch refused");
        let lastEventId: string | null = null;
        for (const { linkSeq, event } of events) {
          if (
            event.tenantId !== node.tenantId ||
            event.outletId !== node.outletId
          )
            throw new Error("Inbound event outside the node scope");
          const eventUuid = ulidToUuid(event.id);
          // edge_to_cloud: primary and standby of one outlet may both send the
          // same event id (the standby took over with the primary's outbox,
          // legend-wg5t), so "received" is tenant-wide and read from the
          // edge_received_events registry. It is a separate table (PK tenant,
          // event) instead of a unique index on edge_inbound_events because old
          // data already holds receipts for one event on two nodes, which
          // would fail such an index. The registry insert below has no ON
          // CONFLICT on purpose: a concurrent duplicate fails the PK, the
          // batch rolls back and the retry skips the event. cloud_to_edge
          // stays per node (each edge node has its own database).
          const seen =
            inbound === "edge_to_cloud"
              ? await tx.execute(
                  sql`SELECT 1 FROM edge_received_events WHERE tenant_id = ${node.tenantId}::uuid AND event_id = ${eventUuid}::uuid`,
                )
              : await tx.execute(
                  sql`SELECT 1 FROM edge_inbound_events WHERE edge_node_id = ${nodeId}::uuid AND direction = ${inbound} AND event_id = ${eventUuid}::uuid`,
                );
          const kind = classify(event);
          const meta: EdgeApplyMeta = {
            edgeNodeId: nodeId,
            edgeInstanceId: options.edgeInstanceId ?? null,
            peerSeqOffset: offset,
            direction: inbound,
            kind,
            context,
          };
          const domainLast = await applier.lastSequence?.(
            tx,
            {
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              sequence: event.sequence,
            },
            meta,
          );
          const lastSequence =
            domainLast ??
            (await defaultLastSequence(tx, nodeId, inbound, kind, event));
          const decision = decideInbound({
            direction: inbound,
            kind,
            alreadyReceived: seen.rows.length > 0,
            lastSequence,
            event,
          });
          lastEventId = event.id;
          if (
            decision.action === "skip" &&
            decision.reason === "already_received"
          ) {
            // Record the slot even though nothing is applied: the restore
            // proof (inboundProof) hashes one receipt per link slot, so a
            // standby re-sending the primary's event must not leave a hole
            // that would make a legitimate edge look restored (legend-tmar2).
            const superseded = await tx.execute(
              sql`INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${inbound}, ${eventUuid}::uuid, ${linkSeq + offset}, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${kind}, 'superseded') ON CONFLICT DO NOTHING RETURNING 1`,
            );
            // The slot belongs to this receipt (new, or already written for
            // this very slot); a receipt kept in another slot claims nothing.
            if (
              superseded.rows.length > 0 ||
              (await receiptAt(tx, eventUuid, linkSeq + offset))
            )
              await claimSlotOrWarn(tx, linkSeq + offset, eventUuid);
            continue;
          }
          let outcome: "applied" | "superseded" | "conflict" | "deferred";
          if (decision.action === "apply") {
            // Savepoint: a domain refusal (CoreError / 4xx) must not roll
            // back the whole batch and stall the node's sync forever
            // (legend-wqc6). It becomes a conflict a supervisor can review;
            // anything else (unwired applier, unclassified event, database
            // failure) still aborts the batch so the sender keeps it queued.
            const result = await applyOrRefuse(tx, applier, event, meta);
            if (result.type === "applied") {
              outcome = "applied";
            } else if (result.type === "deferred") {
              outcome = "deferred";
              deferredStreams.add(result.stream);
            } else {
              outcome = "conflict";
              await recordConflict(tx, {
                event,
                eventUuid,
                kind,
                reason: "applier_refused",
                resolution: conflictResolution(kind),
                lastSequence,
                detail: result.detail,
              });
            }
          } else if (decision.action === "skip") {
            outcome = "superseded";
          } else {
            outcome = "conflict";
            await recordConflict(tx, {
              event,
              eventUuid,
              kind,
              reason: decision.reason,
              resolution: decision.resolution,
              lastSequence,
              detail: null,
            });
          }
          if (inbound === "edge_to_cloud")
            await tx.execute(
              sql`INSERT INTO edge_received_events (tenant_id, outlet_id, event_id, first_edge_node_id) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${eventUuid}::uuid, ${nodeId}::uuid)`,
            );
          await tx.execute(
            sql`INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${inbound}, ${eventUuid}::uuid, ${linkSeq + offset}, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${kind}, ${outcome})`,
          );
          await claimSlotOrWarn(tx, linkSeq + offset, eventUuid);
        }
        await tx.execute(
          sql`UPDATE sync_cursors SET received_in_seq = ${toSeq + offset}, last_event_id = COALESCE(${lastEventId ? ulidToUuid(lastEventId) : null}::uuid, last_event_id), updated_at = now() WHERE edge_node_id = ${nodeId}::uuid AND direction = ${inbound}`,
        );
        if (inbound === "edge_to_cloud")
          await tx.execute(
            sql`UPDATE edge_nodes SET last_sync_cursor = ${String(toSeq + offset)}, updated_at = now() WHERE id = ${nodeId}::uuid`,
          );
      });
      if (deferredStreams.size > 0 && options.onDeferred) {
        try {
          options.onDeferred([...deferredStreams]);
        } catch {
          // The transaction already committed; the periodic HTTP pull remains
          // the recovery path. Never make a committed batch look unacknowledged.
          logger.warn("Unable to wake catalog recovery after a deferred event");
        }
      }
    },
  };
}
