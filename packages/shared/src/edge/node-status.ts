// Back-office "Status edge" contract (beads legend-ph62j, legend-eo3lc;
// docs/design/edge-status-cloud.md section 3). Read-only list of the active
// edge nodes the caller may see, with their open alerts.
//
// Permission: `report.operational.view`, tenant-wide or per outlet. The DTO
// never carries credential, instance, cursor, registration or revoke data.

import {
  z,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
} from "../core/index.ts";

export const EDGE_NODE_ALERT_KINDS = [
  "device_registry_hard_stale",
  "receipt_run_alert",
  "edge_offline",
] as const;
export const edgeNodeAlertKindSchema = z.enum(EDGE_NODE_ALERT_KINDS);
export type EdgeNodeAlertKind = z.infer<typeof edgeNodeAlertKindSchema>;

export const edgeNodeStatusQuerySchema = z.strictObject({
  /** Omitted = every outlet the caller may see. */
  outletId: outletIdSchema.optional(),
});
export type EdgeNodeStatusQuery = z.infer<typeof edgeNodeStatusQuerySchema>;

export const edgeNodeStatusAlertSchema = z.strictObject({
  kind: edgeNodeAlertKindSchema,
  raisedAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});
export type EdgeNodeStatusAlert = z.infer<typeof edgeNodeStatusAlertSchema>;

export const edgeNodeStatusSchema = z.strictObject({
  id: uuidSchema,
  /** The node name; the local bootstrap node is called "local". */
  label: z.string().min(1).max(255),
  role: z.enum(["primary", "standby"]),
  outlet: z.strictObject({
    id: outletIdSchema,
    name: z.string().min(1).max(150),
  }),
  /** Null while the node has not reported a version (column default "unknown"). */
  version: z.string().max(255).nullable(),
  link: z.enum(["connected", "disconnected"]),
  lastHeartbeatAt: isoDateTimeSchema.nullable(),
  /** Open alerts only. */
  alerts: z.array(edgeNodeStatusAlertSchema).max(3),
});
export type EdgeNodeStatus = z.infer<typeof edgeNodeStatusSchema>;

export const edgeNodeStatusListSchema = z.strictObject({
  data: z.array(edgeNodeStatusSchema).max(500),
  meta: z.strictObject({
    generatedAt: isoDateTimeSchema,
    truncated: z.boolean(),
  }),
});
export type EdgeNodeStatusList = z.infer<typeof edgeNodeStatusListSchema>;
