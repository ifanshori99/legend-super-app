// Ports the edge link calls into, owned by other beads (bead legend-2pi
// provides the transport, the durable queue and these hooks only):
//
// - EdgeEventApplier: applies one inbound event to the domain inside the
//   link's receive transaction. Master-data down-sync (legend-97p) installs
//   the cloud -> edge applier on the edge; transaction up-sync (legend-kai)
//   installs the edge -> cloud applier on the cloud. Default: refuse (fail
//   closed). The receive transaction rolls back, nothing is acknowledged and
//   the sender keeps every event queued, so an unwired applier loses nothing.
// - EdgeEventClassifier: master data vs transaction event, decided by the
//   RECEIVER from its own table, never from the peer. Default: unclassified
//   (fail closed, legend-wg5t): an unwired classifier must not silently make
//   everything append-only transaction data, which would let master data
//   bypass cloud-wins. `classifyEdgeEvent` throws, the receive transaction
//   rolls back, nothing is acknowledged and the sender keeps every event
//   queued, exactly like the unwired applier.
// - EdgeDeviceLookup: the calling device for /api/edge/status `thisDevice`,
//   owned by the device registry (legend-165). Default: unknown device.
//
// Installers are called once at bootstrap; tests pass their own doubles.
import type { Device } from "@starter/shared/edge";
import type { EventEnvelope, SyncDirection } from "@starter/shared/events";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { EdgeEventKind } from "../db/schema/edge-node.ts";

export type EdgeApplyMeta = {
  readonly edgeNodeId: string;
  /**
   * The sending edge database's `edge_nodes.instance_id` (legend-o839h);
   * null/absent = unknown (an old edge that does not send it).
   */
  readonly edgeInstanceId?: string | null;
  /**
   * The peer's link sequence offset (sync_cursors.peer_seq_offset) for the
   * direction being applied; a stored link_seq is the peer's linkSeq + this.
   * Absent = 0.
   */
  readonly peerSeqOffset?: number;
  readonly direction: SyncDirection;
  readonly kind: EdgeEventKind;
  readonly context: ScopedTenantContext;
};

/**
 * The aggregate an inbound event belongs to. `sequence` is the incoming
 * event's own aggregate sequence (legend-kyie: lets a domain accept events
 * that it orders itself).
 */
export type EdgeAggregateRef = {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence?: number;
};

/** `Tx` is the tenant transaction (withTenant) the receipt commits in. */
export type EdgeEventApplier<Tx = unknown> = {
  apply(tx: Tx, event: EventEnvelope, meta: EdgeApplyMeta): Promise<void>;
  /**
   * Optional: the domain's own highest sequence for the aggregate (e.g. the
   * order_events stream). Without it the link uses what it has received and
   * queued for this node (db-link-store.ts).
   */
  lastSequence?(
    tx: Tx,
    aggregate: EdgeAggregateRef,
    meta: EdgeApplyMeta,
  ): Promise<number | null>;
};

/**
 * Returns null for an aggregate the receiver does not know (fail closed).
 * `direction` is the direction the event arrives on; omitted by callers that
 * have none (then no per-direction default applies).
 */
export type EdgeEventClassifier = (
  event: EventEnvelope,
  direction?: SyncDirection,
) => EdgeEventKind | null;

export class EdgeEventUnclassifiedError extends Error {
  // aggregateType only: the payload and ids stay out of logs and errors.
  constructor(aggregateType: string) {
    super(
      `No classification for aggregate type ${aggregateType}; the batch stays queued at the sender`,
    );
    this.name = "EdgeEventUnclassifiedError";
  }
}

export class EdgeApplierUnavailableError extends Error {
  constructor(direction: SyncDirection) {
    super(
      `No ${direction} applier is installed; the batch stays queued at the sender`,
    );
    this.name = "EdgeApplierUnavailableError";
  }
}

const refuseApplier = (direction: SyncDirection): EdgeEventApplier => ({
  async apply() {
    throw new EdgeApplierUnavailableError(direction);
  },
});

const appliers = new Map<SyncDirection, EdgeEventApplier>();
let classifier: EdgeEventClassifier = () => null;

export function setEdgeEventApplier(
  direction: SyncDirection,
  applier: EdgeEventApplier | null,
): void {
  if (applier) appliers.set(direction, applier);
  else appliers.delete(direction);
}

export function edgeEventApplier(direction: SyncDirection): EdgeEventApplier {
  return appliers.get(direction) ?? refuseApplier(direction);
}

export function setEdgeEventClassifier(next: EdgeEventClassifier | null): void {
  classifier = next ?? (() => null);
}

export function classifyEdgeEvent(
  event: EventEnvelope,
  direction?: SyncDirection,
): EdgeEventKind {
  const kind = classifier(event, direction);
  if (!kind) throw new EdgeEventUnclassifiedError(event.aggregateType);
  return kind;
}

export type EdgeDeviceLookup = (
  context: ScopedTenantContext,
  deviceId: string,
) => Promise<Device | null>;

let deviceLookup: EdgeDeviceLookup = async () => null;

export function setEdgeDeviceLookup(next: EdgeDeviceLookup | null): void {
  deviceLookup = next ?? (async () => null);
}

export function lookupEdgeDevice(
  context: ScopedTenantContext,
  deviceId: string,
): Promise<Device | null> {
  return deviceLookup(context, deviceId);
}
