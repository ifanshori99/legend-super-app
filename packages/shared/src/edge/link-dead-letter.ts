// Edge -> cloud notice that an event was moved to the edge's dead-letter store
// because it was larger than the link frame (bead legend-btx4d). The event
// itself stays on the edge; the notice is small and travels in the queue so a
// sale never disappears without a trace in the cloud. The cloud applier
// (api edge/link-dead-letter-applier.ts) records a sync conflict, alerts the
// supervisors, and counts the dead event's aggregate sequence as used so the
// events behind it are not refused as a sequence gap.
import { z, ulidSchema } from "../core/index.ts";
import {
  aggregateTypeSchema,
  defineDomainEvent,
  eventNameSchema,
} from "../events/index.ts";

export const EDGE_LINK_AGGREGATE = "edge_link";
export const EDGE_LINK_DEAD_LETTERED_EVENT = "edge_link.dead_lettered";

export const edgeLinkDeadLetteredPayloadSchema = z.strictObject({
  /** Id of the dead-lettered event. */
  eventId: ulidSchema,
  eventName: eventNameSchema,
  aggregateType: aggregateTypeSchema,
  aggregateId: z.string().min(1).max(36),
  aggregateSequence: z.number().int().positive().safe(),
  /** Link sequence the event had on the edge when it was dead-lettered. */
  linkSeq: z.number().int().positive().safe(),
  bytes: z.number().int().min(0).safe(),
  /**
   * frame_too_large: edge -> cloud notice, the event stays on the edge.
   * brand_moved (legend-3k41y): cloud -> edge no-op placeholder that takes the
   * link slot of a catalog row the cloud withheld; the edge only advances.
   */
  reason: z.enum(["frame_too_large", "brand_moved"]),
});
export type EdgeLinkDeadLetteredPayload = z.infer<
  typeof edgeLinkDeadLetteredPayloadSchema
>;

/** Aggregate id of the event is the dead-lettered event id (sequence 1). */
export const edgeLinkDeadLetteredEvent = defineDomainEvent({
  name: EDGE_LINK_DEAD_LETTERED_EVENT,
  payload: edgeLinkDeadLetteredPayloadSchema,
});
