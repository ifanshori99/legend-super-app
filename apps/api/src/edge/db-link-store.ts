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
import { lockSyncCursor, type EdgeTx } from "../services/edge-queue.service.ts";
import { decideInbound, type EdgeConflictReason } from "./conflict.ts";
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
import {
  LinkProtocolError,
  type DeadLetterEntry,
  type LinkStore,
  type QueuedEdgeEvent,
} from "./link-peer.ts";
import { oppositeDirection } from "./protocol.ts";
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
    const result = await tx.execute(
      sql`SELECT COALESCE(MAX(i.aggregate_sequence), 0) AS last FROM edge_inbound_events i WHERE i.edge_node_id = ${edgeNodeId}::uuid AND i.direction = ${direction} AND i.aggregate_type = ${event.aggregateType} AND i.aggregate_id = ${event.aggregateId} AND ${heldReceipt("i")}`,
    );
    return Number(result.rows[0]?.last ?? 0);
  }
  // Append-only stream shared by both sides: an order placed on the cloud
  // (sent down) continues on the edge (sent up), so both directions count.
  const result = await tx.execute(
    sql`SELECT GREATEST(
      (SELECT COALESCE(MAX(i.aggregate_sequence), 0) FROM edge_inbound_events i WHERE i.edge_node_id = ${edgeNodeId}::uuid AND i.aggregate_type = ${event.aggregateType} AND i.aggregate_id = ${event.aggregateId} AND ${heldReceipt("i")}),
      (SELECT COALESCE(MAX(aggregate_sequence), 0) FROM edge_outbound_queue WHERE edge_node_id = ${edgeNodeId}::uuid AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${event.aggregateId})
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

/** Parked above any real link_seq while the queue behind a dead letter is renumbered. */
const RENUMBER_PARK = 1_000_000_000_000;

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

  return {
    ...resume,
    outboundHead: () => cursorValue("next_out_seq", outbound),
    lastAckedOutbound: () => cursorValue("acked_out_seq", outbound),
    lastReceivedInbound: () => cursorValue("received_in_seq", inbound),

    async readOutbound(afterSeq, limit) {
      return run(async (tx) => {
        const { offset } = await peerNumbering(tx, outbound);
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

    async applyInbound({ fromSeq, toSeq, events }) {
      const deferredStreams = new Set<CatalogSyncStream>();
      const applier: EdgeEventApplier<EdgeTx> =
        options.applier ?? edgeEventApplier(inbound);
      const classifyOption = options.classify;
      const classify = (event: EventEnvelope): EdgeEventKind => {
        if (!classifyOption) return classifyEdgeEvent(event, inbound);
        const kind = classifyOption(event, inbound);
        if (!kind) throw new EdgeEventUnclassifiedError(event.aggregateType);
        return kind;
      };
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
          )
            continue;
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
