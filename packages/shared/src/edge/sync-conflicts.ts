// Sync conflict review + replay (bead legend-wqc6; PRD v1.7 §3 F5
// "Sinkronisasi", EDG-02). A conflict is an edge event the cloud refused to
// apply (cloud wins master data; transaction events are never overwritten).
// The conflict row is append-only evidence; a supervisor's decision is a new
// resolution row. A conflict is "open" until a resolution with outcome
// `applied` or `dismissed` exists; a failed replay keeps it open.
//
// Permission: `device.registry.manage` on the conflict's outlet (the API
// resolves the outlet from the conflict, never from the client).

import {
  z,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { eventEnvelopeSchema, syncDirectionSchema } from "../events/index.ts";

export const edgeSyncConflictStatusFilterSchema = z.enum([
  "open",
  "resolved",
  "all",
]);
export type EdgeSyncConflictStatusFilter = z.infer<
  typeof edgeSyncConflictStatusFilterSchema
>;

export const edgeSyncConflictStatusSchema = z.enum(["open", "resolved"]);
export type EdgeSyncConflictStatus = z.infer<
  typeof edgeSyncConflictStatusSchema
>;

export const edgeSyncConflictActionSchema = z.enum(["replayed", "dismissed"]);
export const edgeSyncConflictOutcomeSchema = z.enum([
  "applied",
  "failed",
  "dismissed",
]);

export const edgeSyncConflictResolutionSchema = z.strictObject({
  id: ulidSchema,
  conflictId: ulidSchema,
  action: edgeSyncConflictActionSchema,
  outcome: edgeSyncConflictOutcomeSchema,
  /** Applier error of a failed replay; null otherwise. */
  error: z.string().nullable(),
  note: z.string().max(500),
  resolvedBy: z.string().min(1),
  resolvedAt: isoDateTimeSchema,
});
export type EdgeSyncConflictResolution = z.infer<
  typeof edgeSyncConflictResolutionSchema
>;

const conflictFields = {
  id: ulidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  edgeNodeId: uuidSchema,
  direction: syncDirectionSchema,
  eventId: ulidSchema,
  aggregateType: z.string().min(1).max(255),
  aggregateId: z.string().min(1).max(36),
  aggregateSequence: z.number().int().nonnegative(),
  kind: z.enum(["master_data", "transaction_event"]),
  reason: z.string().min(1).max(50),
  resolution: z.enum(["cloud_wins", "append_only"]),
  existingSequence: z.number().int().nonnegative(),
  status: edgeSyncConflictStatusSchema,
  createdAt: isoDateTimeSchema,
  /** Latest resolution row, if any (an open conflict can have a failed one). */
  lastResolution: edgeSyncConflictResolutionSchema.nullable(),
};

/** List row: no envelope (it can be large and carries business data). */
export const edgeSyncConflictSummarySchema = z.strictObject(conflictFields);
export type EdgeSyncConflictSummary = z.infer<
  typeof edgeSyncConflictSummarySchema
>;

/** Detail: the full refused envelope and every resolution, oldest first. */
export const edgeSyncConflictDetailSchema = z.strictObject({
  ...conflictFields,
  event: eventEnvelopeSchema,
  resolutions: z.array(edgeSyncConflictResolutionSchema),
});
export type EdgeSyncConflictDetail = z.infer<
  typeof edgeSyncConflictDetailSchema
>;

export const edgeSyncConflictListQuerySchema = cursorPageQuerySchema.extend({
  /** Omitted = every outlet the caller may manage. */
  outletId: outletIdSchema.optional(),
  edgeNodeId: uuidSchema.optional(),
  status: edgeSyncConflictStatusFilterSchema.default("open"),
});
export type EdgeSyncConflictListQuery = z.infer<
  typeof edgeSyncConflictListQuerySchema
>;

export const edgeSyncConflictParamsSchema = z.strictObject({
  conflictId: ulidSchema,
});

export const resolveEdgeSyncConflictBodySchema = z.strictObject({
  action: z.enum(["replay", "dismiss"]),
  /** Why the supervisor decided so; kept in the resolution and the audit log. */
  note: z.string().trim().min(1).max(500),
});
export type ResolveEdgeSyncConflictBody = z.infer<
  typeof resolveEdgeSyncConflictBodySchema
>;

export const listEdgeSyncConflicts = defineEndpoint({
  method: "GET",
  path: "/api/edge-sync-conflicts",
  query: edgeSyncConflictListQuerySchema,
  response: cursorPageSchema(edgeSyncConflictSummarySchema),
});

export const getEdgeSyncConflict = defineEndpoint({
  method: "GET",
  path: "/api/edge-sync-conflicts/:conflictId",
  params: edgeSyncConflictParamsSchema,
  response: dataResponseSchema(edgeSyncConflictDetailSchema),
});

/**
 * Replay re-applies the refused envelope through the installed applier in a
 * savepoint. A throwing applier answers 200 with the conflict still open and a
 * `failed` resolution; resolving an already-resolved conflict returns it
 * unchanged (idempotent).
 */
export const resolveEdgeSyncConflict = defineEndpoint({
  method: "POST",
  path: "/api/edge-sync-conflicts/:conflictId/resolve",
  params: edgeSyncConflictParamsSchema,
  body: resolveEdgeSyncConflictBodySchema,
  response: dataResponseSchema(edgeSyncConflictDetailSchema),
});
