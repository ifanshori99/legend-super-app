// Conflict rules of the cloud <-> edge link (bead legend-2pi; PRD v1.7 §3 F5
// "Pembagian Sumber Kebenaran" + "Sinkronisasi": "Konflik master data
// dimenangkan cloud; event transaksi tidak pernah ditimpa"). Pure functions,
// shared by the Postgres link store and the tests.
//
// The receiver decides per event, after link-level dedupe:
//   1. An event id it already holds is skipped (idempotent apply, at least
//      once delivery).
//   2. master_data travels cloud -> edge only. One arriving from an edge is
//      refused and recorded (`edge_master_data`, cloud wins).
//   3. master_data events carry full state (legend-97p must emit them so):
//      a newer sequence applies even across a gap (the newest cloud state
//      wins), an older or equal one is `superseded` and skipped.
//   4. transaction_event is append-only: only the next aggregate sequence
//      applies. A sequence already taken by another event (`sequence_collision`)
//      or a hole before it (`sequence_gap`) is never applied over existing
//      history; it is recorded with its full envelope for reconciliation, so
//      nothing is lost and nothing is overwritten.
import {
  classifyEventSequence,
  type EventEnvelope,
  type SyncDirection,
} from "@starter/shared/events";
import { conflictResolution } from "@starter/shared/edge";
import type {
  EdgeConflictResolution,
  EdgeEventKind,
} from "../db/schema/edge-node.ts";

export type EdgeConflictReason =
  | "edge_master_data"
  | "sequence_collision"
  | "sequence_gap"
  /** The domain applier refused the event (CoreError / 4xx), legend-wqc6. */
  | "applier_refused";

export type InboundDecision =
  | { action: "apply" }
  | { action: "skip"; reason: "already_received" | "superseded" }
  | {
      action: "conflict";
      reason: EdgeConflictReason;
      resolution: EdgeConflictResolution;
    };

export function decideInbound(input: {
  direction: SyncDirection;
  kind: EdgeEventKind;
  alreadyReceived: boolean;
  /** Highest aggregate sequence this side already holds (0 = none). */
  lastSequence: number;
  event: Pick<EventEnvelope, "sequence">;
}): InboundDecision {
  if (input.alreadyReceived)
    return { action: "skip", reason: "already_received" };
  const resolution = conflictResolution(input.kind);
  if (input.kind === "master_data") {
    if (input.direction !== "cloud_to_edge")
      return { action: "conflict", reason: "edge_master_data", resolution };
    return input.event.sequence > input.lastSequence
      ? { action: "apply" }
      : { action: "skip", reason: "superseded" };
  }
  const order = classifyEventSequence(input.lastSequence, input.event);
  if (order.action === "apply") return { action: "apply" };
  return {
    action: "conflict",
    reason:
      order.action === "duplicate" ? "sequence_collision" : "sequence_gap",
    resolution,
  };
}

/**
 * Sender-side ordering rule for the offline queue (per aggregate, per
 * direction). `lastQueued` is the highest aggregate sequence already queued
 * for this aggregate in this direction, or null when none is queued. A
 * transaction event must be the next sequence; master data only has to be
 * newer (full-state events may skip versions). Returns a refusal message or
 * null when the event may be queued.
 */
export function queueOrderViolation(input: {
  kind: EdgeEventKind;
  direction: SyncDirection;
  lastQueued: number | null;
  sequence: number;
}): string | null {
  if (input.kind === "master_data" && input.direction !== "cloud_to_edge")
    return "Master data is owned by the cloud and never sent from an edge";
  if (input.lastQueued === null) return null;
  if (input.kind === "master_data")
    return input.sequence > input.lastQueued
      ? null
      : "Master data event is not newer than the queued version";
  return input.sequence === input.lastQueued + 1
    ? null
    : "Transaction events must be queued in aggregate sequence order";
}
