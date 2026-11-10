// Cloud side of the edge -> cloud `attendance.logged` up-sync (bead legend-wh71,
// PRD F25 offline attendance). The edge records a clock-in while the link is
// down and up-syncs `attendance.logged` once it is back; this handler runs in
// the cloud link's receive transaction (edge/db-link-store.ts applyInbound) and
// stores it with recordAttendanceLog as an `offline = true` log. The client
// time is trusted for an offline event; a time far off the receive time is
// flagged `offline_time_skew` by recordAttendanceLog.
//
// The edge already vetted device, QR and geofence, and the event carries none
// of them, so the log is stored as a plain event. Its idempotency identity is
// the edge's own log id (payload.attendanceLogId): a re-delivered envelope, or
// a second envelope for the same edge log, never makes a second row.
//
// Fail closed: a payload that does not parse, an event outside the node's
// tenant/outlet, or an employee the tenant does not hold throws a CoreError;
// the link records it as an `applier_refused` conflict (db-link-store.ts).
import { and, eq } from "drizzle-orm";
import { CoreError, isOutletInScope } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { attendanceLogged } from "@starter/shared/hris";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { employees } from "../db/schema/hris.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { recordAttendanceLog } from "../services/hris-attendance.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import type { EdgeApplyMeta } from "./ports.ts";

export const ATTENDANCE_LOGGED_EVENT = "attendance.logged";

/** Applies one edge `attendance.logged` on the cloud; replays write nothing. */
export async function applyEdgeAttendanceLogged(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  if (meta.direction !== "edge_to_cloud")
    throw new CoreError(
      "FORBIDDEN",
      "attendance.logged is only accepted from an edge",
    );
  const tenantId = meta.context.tenant.tenantId;
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  const outletId = event.outletId;
  if (!outletId || !isOutletInScope(meta.context.outletScope, outletId))
    throw new CoreError("FORBIDDEN", "Event outlet is outside the node scope");
  const [node] = await tx
    .select({ outletId: edgeNodes.outletId })
    .from(edgeNodes)
    .where(
      and(eq(edgeNodes.tenantId, tenantId), eq(edgeNodes.id, meta.edgeNodeId)),
    );
  if (!node || node.outletId !== outletId)
    throw new CoreError(
      "FORBIDDEN",
      "Event outlet does not match the edge node",
    );

  const parsed = attendanceLogged.payloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Invalid attendance.logged payload",
    );
  const payload = parsed.data;
  if (
    event.aggregateType !== attendanceLogged.entry.aggregateType ||
    event.aggregateId !== payload.attendanceLogId
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Event does not match its attendance log",
    );
  if (payload.outletId !== outletId)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Payload outlet does not match the event outlet",
    );

  const [employee] = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, tenantId),
        eq(employees.id, payload.employeeId),
      ),
    )
    .limit(1);
  if (!employee)
    throw new CoreError("FORBIDDEN", "Employee does not belong to the tenant");

  await recordAttendanceLog(
    tx,
    { tenantId, outletId },
    {
      employeeId: payload.employeeId,
      type: payload.type,
      method: payload.method,
      occurredAt: new Date(payload.occurredAt),
      receivedAt: new Date(),
      location: null,
      deviceIdHash: null,
      photoKey: null,
      qrToken: null,
      clientEventId: payload.attendanceLogId,
      offline: true,
    },
  );
}

/**
 * Cloud boot (registerEdgeLink): routes edge `attendance.logged` to this
 * handler and classifies the attendance aggregate as an append-only
 * transaction event. Idempotent.
 */
export function registerAttendanceLoggedEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    ATTENDANCE_LOGGED_EVENT,
    applyEdgeAttendanceLogged,
  );
  registerEdgeAggregateKind(
    attendanceLogged.entry.aggregateType,
    "transaction_event",
  );
}
