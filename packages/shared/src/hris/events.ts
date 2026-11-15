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
  uuidSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import {
  attendanceLogIdSchema,
  employeeIdSchema,
  leaveRequestIdSchema,
  offboardingIdSchema,
  leaveTypeIdSchema,
  shiftAssignmentIdSchema,
  shiftTemplateIdSchema,
  stationIdSchema,
} from "./ids.ts";
import {
  attendanceMethodSchema,
  attendanceStoredFlagReasonSchema,
  attendanceTypeSchema,
  attendanceValiditySchema,
} from "./attendance.ts";

/**
 * Emitted once per accepted attendance log, including offline edge replay (F25).
 *
 * Pay boundary (legend-x0avw F6): `validity` is the value at clock time and the
 * log can change afterwards (a later approved leave flags it `leave_approved`,
 * HR can accept or reject it) without a new event. A consumer that counts
 * worked time or pay MUST exclude validity `flagged` and `rejected` and
 * review_status `pending`, and MUST re-read the log's current status before
 * computing pay or timing; the event alone is never proof the day was worked.
 */
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
    /** v2 (edge): sealed selfie object id; absent on v1 payloads. */
    selfieObjectId: uuidSchema.nullable().optional(),
    /** v2 (edge): reasons the edge attached; the cloud unions them with its own. */
    edgeFlagReasons: z
      .array(attendanceStoredFlagReasonSchema)
      .max(10)
      .optional(),
    /** v2 (edge): outlet device that recorded the clock. */
    edgeDeviceId: z.string().min(1).max(100).nullable().optional(),
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

/**
 * Emitted when HR changes an already approved leave range (legend-x0avw F5):
 * one event per leave row that changed. `range_split`: the row was narrowed
 * (head, or the rest when the first or last day went) or is the new tail row
 * (`splitFromLeaveRequestId` names the row it was split from). `range_cancelled`:
 * the whole leave was cancelled by HR (`status` cancelled). `requester_cancelled`:
 * the requester (or HR through the leave screen) cancelled an approved leave
 * before it started (`status` cancelled). Carries the row's state
 * after the change; `leave.approved` stays the event of the approval itself.
 */
export const leaveChanged = defineDomainEvent({
  name: "leave.changed",
  payload: z.strictObject({
    leaveRequestId: leaveRequestIdSchema,
    employeeId: employeeIdSchema,
    outletId: outletIdSchema,
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    days: decimal4Schema,
    excludedHolidayDates: z.array(businessDateSchema).max(400),
    status: z.enum(["approved", "cancelled"]),
    changeReason: z.enum([
      "range_split",
      "range_cancelled",
      "requester_cancelled",
    ]),
    splitFromLeaveRequestId: leaveRequestIdSchema.nullable(),
  }),
});

/**
 * Emitted when a collective leave day is deducted again (an accepted clock-in
 * was rejected) for an employee whose offboarding is already `completed`
 * (legend-jitc3). The frozen settlement snapshot is NOT changed and no
 * receivable is created: the event tells HR the employee owes `days` more, to
 * be billed by hand. `aggregateId` is the rededuction ledger row. Ids, dates
 * and days only: no name, pay or reason text.
 */
export const leaveRedeductedAfterSettlement = defineDomainEvent({
  name: "leave.rededucted_after_settlement",
  payload: z.strictObject({
    offboardingId: offboardingIdSchema,
    employeeId: employeeIdSchema,
    outletId: outletIdSchema,
    date: businessDateSchema,
    periodYear: z.number().int().min(2000).max(2100),
    days: decimal4Schema,
  }),
});

export const hrisDomainEvents = [
  attendanceLogged,
  shiftPublished,
  shiftCancelled,
  leaveApproved,
  leaveChanged,
  leaveRedeductedAfterSettlement,
] as const;

export const hrisEventNames = hrisDomainEvents.map((event) => event.name);
export type HrisEventName = (typeof hrisEventNames)[number];
