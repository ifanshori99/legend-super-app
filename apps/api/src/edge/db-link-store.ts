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
import { conflictResolution } from "@starter/shared/edge";
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
import { withTenant } from "../db/tenant.ts";
import {
  notifyEdgeSyncConflictRecorded,
  type NewEdgeSyncConflict,
} from "../services/edge-sync-conflict-alert.ts";
import { lockSyncCursor, type EdgeTx } from "../services/edge-queue.service.ts";
import { decideInbound, type EdgeConflictReason } from "./conflict.ts";
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
import type { LinkStore, QueuedEdgeEvent } from "./link-peer.ts";
import { oppositeDirection } from "./protocol.ts";
import {
  classifyEdgeEvent,
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
  /** Test seams; production uses the installed ports. */
  applier?: EdgeEventApplier<EdgeTx>;
  /** Must return a kind; null/throw refuses the batch (ports.ts, fail closed). */
  classify?: EdgeEventClassifier;
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
 * Runs the applier in a savepoint. Returns null when it applied, or the
 * refusal text (max 500 characters) after rolling the savepoint back.
 */
async function applyOrRefuse(
  tx: EdgeTx,
  applier: EdgeEventApplier<EdgeTx>,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<string | null> {
  try {
    await tx.transaction((savepoint) => applier.apply(savepoint, event, meta));
    return null;
  } catch (error) {
    if (!isDomainRefusal(error)) throw error;
    return (error as Error).message.slice(0, 500);
  }
}

export function createDbLinkStore(options: DbLinkStoreOptions): LinkStore {
  const { database, context, node } = options;
  assertTrustedScopedContext(context);
  const outbound = options.outboundDirection;
  const inbound = oppositeDirection(outbound);
  const nodeId = node.edgeNodeId;
  const run = <T>(work: (tx: EdgeTx) => Promise<T>) =>
    withTenant(database, context, work);

  async function cursorValue(
    column: "next_out_seq" | "acked_out_seq" | "received_in_seq",
    direction: SyncDirection,
  ) {
    return run(async (tx) => {
      const result = await tx.execute(
        sql`SELECT next_out_seq, acked_out_seq, received_in_seq FROM sync_cursors WHERE edge_node_id = ${nodeId}::uuid AND direction = ${direction}`,
      );
      return Number(result.rows[0]?.[column] ?? 0);
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

  return {
    outboundHead: () => cursorValue("next_out_seq", outbound),
    lastAckedOutbound: () => cursorValue("acked_out_seq", outbound),
    lastReceivedInbound: () => cursorValue("received_in_seq", inbound),

    async readOutbound(afterSeq, limit) {
      return run(async (tx) => {
        const result = await tx.execute(
          sql`SELECT link_seq, event FROM edge_outbound_queue WHERE edge_node_id = ${nodeId}::uuid AND direction = ${outbound} AND link_seq > ${afterSeq} ORDER BY link_seq LIMIT ${limit}`,
        );
        return result.rows.map((row): QueuedEdgeEvent => ({
          linkSeq: Number(row.link_seq),
          event: eventEnvelopeSchema.parse(row.event),
        }));
      });
    },

    async ackOutbound(uptoSeq) {
      await run(async (tx) => {
        const cursor = await lockSyncCursor(tx, node, outbound);
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
        if (cursor.received_in_seq !== fromSeq)
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
          let outcome: "applied" | "superseded" | "conflict";
          if (decision.action === "apply") {
            // Savepoint: a domain refusal (CoreError / 4xx) must not roll
            // back the whole batch and stall the node's sync forever
            // (legend-wqc6). It becomes a conflict a supervisor can review;
            // anything else (unwired applier, unclassified event, database
            // failure) still aborts the batch so the sender keeps it queued.
            const refusal = await applyOrRefuse(tx, applier, event, meta);
            if (refusal === null) {
              outcome = "applied";
            } else {
              outcome = "conflict";
              await recordConflict(tx, {
                event,
                eventUuid,
                kind,
                reason: "applier_refused",
                resolution: conflictResolution(kind),
                lastSequence,
                detail: refusal,
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
            sql`INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome) VALUES (${node.tenantId}::uuid, ${node.outletId}::uuid, ${nodeId}::uuid, ${inbound}, ${eventUuid}::uuid, ${linkSeq}, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${kind}, ${outcome})`,
          );
        }
        await tx.execute(
          sql`UPDATE sync_cursors SET received_in_seq = ${toSeq}, last_event_id = COALESCE(${lastEventId ? ulidToUuid(lastEventId) : null}::uuid, last_event_id), updated_at = now() WHERE edge_node_id = ${nodeId}::uuid AND direction = ${inbound}`,
        );
        if (inbound === "edge_to_cloud")
          await tx.execute(
            sql`UPDATE edge_nodes SET last_sync_cursor = ${String(toSeq)}, updated_at = now() WHERE id = ${nodeId}::uuid`,
          );
      });
    },
  };
}
