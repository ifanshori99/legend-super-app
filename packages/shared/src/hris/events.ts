// HR-domain event payloads (PRD v1.7 §3 F25–F29; naming `<aggregate>.<past_verb>`
// per docs/plan/contracts.md). Envelope, outbox and catalog are the WS-00 event
// contract (bead legend-m59); every name below is registered on the WS-10 line
// of `events/catalog.ts`.
//
// Payloads are JSON only and carry no PII: no reason text, no attachment or
// selfie URL, no NIK/NPWP/bank/salary. Consumers read personal data through the
// guarded queries, never from the event stream.

import {
  z,
  outletIdSchema,
  userIdSchema,
  isoDateTimeSchema,
  businessDateSchema,
  decimal4Schema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import {
  attendanceLogIdSchema,
  employeeIdSchema,
  leaveRequestIdSchema,
  leaveTypeIdSchema,
  shiftAssignmentIdSchema,
  shiftTemplateIdSchema,
  stationIdSchema,
} from "./ids.ts";
import {
  attendanceMethodSchema,
  attendanceTypeSchema,
  attendanceValiditySchema,
} from "./attendance.ts";

/** Emitted once per accepted attendance log, including offline edge replay (F25). */
export const attendanceLogged = defineDomainEvent({
  name: "attendance.logged",
  payload: z.strictObject({
    attendanceLogId: attendanceLogIdSchema,
    employeeId: employeeIdSchema,
    outletId: outletIdSchema,
    type: attendanceTypeSchema,
    method: attendanceMethodSchema,
    occurredAt: isoDateTimeSchema,
    validity: attendanceValiditySchema,
    shiftAssignmentId: shiftAssignmentIdSchema.nullable(),
  }),
});

/** Emitted per assignment when a roster week is published (F26). */
export const shiftPublished = defineDomainEvent({
  name: "shift.published",
  payload: z.strictObject({
    shiftAssignmentId: shiftAssignmentIdSchema,
    employeeId: employeeIdSchema,
    outletId: outletIdSchema,
    shiftTemplateId: shiftTemplateIdSchema.nullable(),
    stationId: stationIdSchema.nullable(),
    businessDate: businessDateSchema,
    segments: z
      .array(
        z.strictObject({
          startsAt: isoDateTimeSchema,
          endsAt: isoDateTimeSchema,
        }),
      )
      .min(1)
      .max(2),
    publishedBy: userIdSchema,
    publishedAt: isoDateTimeSchema,
  }),
});

/**
 * Emitted when a published shift stops being the employee's: the manager
 * cancelled it (`cancelled`) or an approved swap/cover handed it to someone
 * else (`swapped_away`, `employeeId` is the previous owner). The new owner
 * hears about a swap through `shift.published`.
 */
export const shiftCancelled = defineDomainEvent({
  name: "shift.cancelled",
  payload: z.strictObject({
    shiftAssignmentId: shiftAssignmentIdSchema,
    employeeId: employeeIdSchema,
    outletId: outletIdSchema,
    businessDate: businessDateSchema,
    cause: z.enum(["cancelled", "swapped_away"]),
    cancelledBy: userIdSchema,
    cancelledAt: isoDateTimeSchema,
  }),
});

/** Emitted when a leave request is approved; balance deduction follows (F27). */
export const leaveApproved = defineDomainEvent({
  name: "leave.approved",
  payload: z.strictObject({
    leaveRequestId: leaveRequestIdSchema,
    employeeId: employeeIdSchema,
    leaveTypeId: leaveTypeIdSchema,
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    days: decimal4Schema,
    decidedBy: userIdSchema,
    decidedAt: isoDateTimeSchema,
  }),
});

export const hrisDomainEvents = [
  attendanceLogged,
  shiftPublished,
  shiftCancelled,
  leaveApproved,
] as const;

export const hrisEventNames = hrisDomainEvents.map((event) => event.name);
export type HrisEventName = (typeof hrisEventNames)[number];
