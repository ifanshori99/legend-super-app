// Edge -> cloud node alarm events (beads legend-uvnll, legend-0cjzz;
// docs/design/edge-status-cloud.md D1/D2). The alarm travels on the edge event
// stream (exactly once, acked after the cloud transaction), not on the
// heartbeat. The payload carries NO tenant, outlet or node id: the cloud takes
// them from the edge credential.
//
// Envelope rules (same as print_alert.raised): version 1, aggregateType
// "edge_node_alarm", aggregateId === id, sequence 1, idempotencyKey
// "<name>:<id>", occurredAt = edge time of the transition.

import { z, isoDateTimeSchema } from "../core/index.ts";

export const EDGE_NODE_ALARM_AGGREGATE = "edge_node_alarm";
export const EDGE_NODE_ALARM_RAISED = "edge_node_alarm.raised";
export const EDGE_NODE_ALARM_CLEARED = "edge_node_alarm.cleared";

/** v1 carries one kind; the cloud refuses others. */
export const EDGE_NODE_ALARM_KINDS = ["device_registry_hard_stale"] as const;
export const edgeNodeAlarmKindSchema = z.enum(EDGE_NODE_ALARM_KINDS);
export type EdgeNodeAlarmKind = z.infer<typeof edgeNodeAlarmKindSchema>;

export const edgeNodeAlarmRaisedPayloadSchema = z.strictObject({
  kind: z.literal("device_registry_hard_stale"),
  /** Last successful registry pull; null when the replica never pulled. */
  lastPulledAt: isoDateTimeSchema.nullable(),
  // Same bounds as EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS (api edge/config.ts).
  maxStaleSeconds: z.number().int().min(3600).max(2_592_000),
});
export type EdgeNodeAlarmRaisedPayload = z.infer<
  typeof edgeNodeAlarmRaisedPayloadSchema
>;

export const edgeNodeAlarmClearedPayloadSchema = z.strictObject({
  kind: z.literal("device_registry_hard_stale"),
  /** Null only when a reboot reset the age base before any pull succeeded. */
  lastPulledAt: isoDateTimeSchema.nullable(),
});
export type EdgeNodeAlarmClearedPayload = z.infer<
  typeof edgeNodeAlarmClearedPayloadSchema
>;
