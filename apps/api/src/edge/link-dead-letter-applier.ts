// Cloud side of the edge link dead letter (bead legend-btx4d). An edge moves
// an event above the link frame cap to its dead-letter store and queues the
// small `edge_link.dead_lettered` notice instead. Applying it:
//   - records ONE sync conflict for the dead event (reason
//     `link_event_dead_lettered`, aggregate and sequence of the dead event, the
//     notice as evidence) and alerts the outlet supervisors, so a sale never
//     vanishes without a trace;
//   - writes an `applied` receipt for the dead event's aggregate sequence, so
//     that sequence counts as used and the next event of the aggregate is not
//     refused as a `sequence_gap`.
// Both writes are idempotent per dead event id.
import { sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  conflictResolution,
  EDGE_LINK_AGGREGATE,
  EDGE_LINK_DEAD_LETTERED_EVENT,
  edgeLinkDeadLetteredPayloadSchema,
} from "@starter/shared/edge";
import type { EventEnvelope } from "@starter/shared/events";
import { notifyEdgeSyncConflictRecorded } from "../services/edge-sync-conflict-alert.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import type { EdgeEventHandler } from "./applier-registry.ts";
import { assertEdgeEventScope } from "./deferred-event-applier.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/** Conflict reason of an event the edge could not send (frame too large). */
export const LINK_EVENT_DEAD_LETTERED_REASON = "link_event_dead_lettered";

export async function applyEdgeLinkDeadLettered(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const parsed = edgeLinkDeadLetteredPayloadSchema.safeParse(event.payload);
  // The notice is its own aggregate, keyed by the dead event id: any other id
  // is a forged or garbled notice and must not mark a sequence as used.
  if (
    !parsed.success ||
    event.aggregateType !== EDGE_LINK_AGGREGATE ||
    event.aggregateId !== parsed.data.eventId
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      `Invalid ${EDGE_LINK_DEAD_LETTERED_EVENT} payload`,
    );
  const dead = parsed.data;
  const tenantId = meta.context.tenant.tenantId;
  const deadUuid = ulidToUuid(dead.eventId);
  const detail =
    `${dead.reason} ${dead.eventName} link seq ${dead.linkSeq} ${dead.bytes} bytes`.slice(
      0,
      500,
    );
  const conflictId = createUlid();
  const inserted = await tx.execute(
    sql`INSERT INTO edge_sync_conflicts (id, tenant_id, outlet_id, edge_node_id, direction, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, reason, resolution, existing_sequence, detail, event) VALUES (${ulidToUuid(conflictId)}::uuid, ${tenantId}::uuid, ${outletId}::uuid, ${meta.edgeNodeId}::uuid, ${meta.direction}, ${deadUuid}::uuid, ${dead.aggregateType}, ${dead.aggregateId}, ${dead.aggregateSequence}, ${meta.kind}, ${LINK_EVENT_DEAD_LETTERED_REASON}, ${conflictResolution(meta.kind)}, ${Math.max(0, dead.aggregateSequence - 1)}, ${detail}, ${JSON.stringify(event)}::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
  );
  // The sequence of the dead event counts as held (defaultLastSequence reads
  // `applied` receipts). Never received for real: its id is not registered in
  // edge_received_events.
  await tx.execute(
    sql`INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome) VALUES (${tenantId}::uuid, ${outletId}::uuid, ${meta.edgeNodeId}::uuid, ${meta.direction}, ${deadUuid}::uuid, ${dead.linkSeq + (meta.peerSeqOffset ?? 0)}, ${dead.aggregateType}, ${dead.aggregateId}, ${dead.aggregateSequence}, 'transaction_event', 'applied') ON CONFLICT DO NOTHING`,
  );
  if (inserted.rows.length === 0) return;
  // Supervisor alert in a savepoint: never fails the batch (the conflict row
  // is the durable evidence), as in db-link-store.ts.
  try {
    await tx.transaction((savepoint) =>
      notifyEdgeSyncConflictRecorded(savepoint, meta.context, {
        id: conflictId,
        tenantId: tenantIdSchema.parse(tenantId),
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: meta.edgeNodeId,
        aggregateType: dead.aggregateType,
        reason: LINK_EVENT_DEAD_LETTERED_REASON,
      }),
    );
  } catch {
    // Intentionally silent: no payload or ids in logs (ports.ts rule).
  }
}

// Stable identity: the registry treats a different handler as a wiring bug.
const handleEdgeLinkDeadLettered: EdgeEventHandler = applyEdgeLinkDeadLettered;

/**
 * Cloud boot (registerEdgeLink): applies `edge_link.dead_lettered` from an
 * edge and classifies the `edge_link` aggregate as append-only transaction
 * events. Idempotent.
 */
export function registerEdgeLinkDeadLetterApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    EDGE_LINK_DEAD_LETTERED_EVENT,
    handleEdgeLinkDeadLettered,
  );
  registerEdgeAggregateKind(EDGE_LINK_AGGREGATE, "transaction_event");
}
