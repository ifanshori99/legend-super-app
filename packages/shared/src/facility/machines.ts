// Typed state machines and timing rules for facility access (PRD v1.7 §6 K
// status columns; docs/plan/contracts.md: "money and state transitions only
// through the contract state machines"). Pure functions: the API, the edge and
// the FE run the same rules, and a test can name the acceptance criterion.
//
// Window model (FAC-01). A ticket opens exactly one unit, in exactly one area,
// and only inside its own session:
//
//   startsAt − graceMinutes ─── door opens ─── startsAt ─── session ─── endsAt
//   endsAt is the last instant the door opens; the cleaning buffer that
//   follows is staff-only. The arrival tolerance lets a guest open the door
//   early; it never extends the session. Re-opening inside the session is
//   allowed (same ticket, same unit); another session needs another ticket.

import {
  z,
  idrSchema,
  isoDateTimeSchema,
  multiplyIdr,
  businessDateOf,
  toIsoDateTime,
  type BusinessDayClock,
} from "../core/index.ts";
import { FacilityError } from "./errors.ts";
import type {
  AccessTicket,
  AccessTicketStatus,
  CancellationPolicy,
  CancellationResolution,
  CleaningChecklist,
  CleaningTask,
  FacilityIncident,
  FacilityUnitStatus,
  OvertimePolicy,
} from "./schemas.ts";
import {
  cleaningChecklistSchema,
  facilitySubscriptionSchema,
} from "./schemas.ts";
import type {
  FacilitySubscription,
  FacilitySubscriptionStatus,
  SubscriptionQuota,
} from "./schemas.ts";

const MINUTE = 60_000;

/** Door window of a ticket: arrival tolerance start to session end (FAC-01). */
export const ticketCredentialWindowSchema = z.strictObject({
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema,
});
export type TicketCredentialWindow = z.infer<
  typeof ticketCredentialWindowSchema
>;

export function ticketCredentialWindow(
  ticket: AccessTicket,
): TicketCredentialWindow {
  const startsAt = Date.parse(ticket.slot.startsAt);
  return ticketCredentialWindowSchema.parse({
    validFrom: toIsoDateTime(new Date(startsAt - ticket.graceMinutes * MINUTE)),
    validUntil: ticket.slot.endsAt,
  });
}

/** True inside `[validFrom, validUntil)`; the customer's own session only. */
export function isWithinCredentialWindow(
  window: TicketCredentialWindow,
  at: Date | string,
): boolean {
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  return (
    time >= Date.parse(window.validFrom) && time < Date.parse(window.validUntil)
  );
}

/** FAC-01: a ticket is usable only while issued or in use, and only in its window. */
export function isTicketUsableAt(
  ticket: AccessTicket,
  at: Date | string,
): boolean {
  if (ticket.status !== "issued" && ticket.status !== "in_use") return false;
  return isWithinCredentialWindow(ticketCredentialWindow(ticket), at);
}

export function assertTicketUsableAt(
  ticket: AccessTicket,
  at: Date | string,
): void {
  if (!isTicketUsableAt(ticket, at))
    throw new FacilityError(
      "TICKET_WINDOW_CLOSED",
      "Tiket ini di luar jendela sesi.",
    );
}

// ---- Ticket status machine --------------------------------------------------

/** Statuses that release the unit's range (FAC-02, PRD §6 K). */
export const SLOT_RELEASING_TICKET_STATUSES = [
  "cancelled",
  "refunded",
  "no_show",
] as const satisfies readonly AccessTicketStatus[];

/**
 * FAC-02 + PRD §6 K: a ticket keeps its unit's range until it is cancelled,
 * refunded or lost to a no-show. Postgres supports this directly with a
 * partial exclusion constraint, so the migration (bead legend-nm4f) uses
 * `SLOT_HOLD_PREDICATE_SQL` and never rewrites the stored slot:
 *
 *   EXCLUDE USING gist (tenant_id WITH =, unit_id WITH =, slot WITH &&)
 *     WHERE (status NOT IN ('cancelled','refunded','no_show'))
 *
 * The stored range stays intact for audit and reporting. This function is the
 * application-side answer to "does this status still hold the slot?" and must
 * agree with the predicate (contract test).
 */
export function ticketHoldsSlot(status: AccessTicketStatus): boolean {
  return !(SLOT_RELEASING_TICKET_STATUSES as readonly string[]).includes(
    status,
  );
}

/** The exclusion constraint's WHERE clause, built from the same list. */
export const SLOT_HOLD_PREDICATE_SQL = `status NOT IN (${SLOT_RELEASING_TICKET_STATUSES.map(
  (status) => `'${status}'`,
).join(",")})`;

export type TicketAction =
  "mark_paid" | "open" | "end" | "mark_no_show" | "cancel" | "refund";

const ticketTransitions: Record<
  AccessTicketStatus,
  Partial<Record<TicketAction, AccessTicketStatus>>
> = {
  // Paid or entitlement redeemed: the ticket becomes usable (FAC-04).
  pending_payment: { mark_paid: "issued", cancel: "cancelled" },
  issued: {
    open: "in_use",
    mark_no_show: "no_show",
    cancel: "cancelled",
    refund: "refunded",
  },
  in_use: { end: "completed" },
  completed: {},
  // PRD §3 F22: a no-show ticket is forfeited per policy; a later refund is a
  // WS-05 payment refund, not another ticket status.
  no_show: {},
  cancelled: { refund: "refunded" },
  refunded: {},
};

export function canTransitionTicket(
  status: AccessTicketStatus,
  action: TicketAction,
): boolean {
  return ticketTransitions[status]?.[action] !== undefined;
}

export function transitionTicket(
  status: AccessTicketStatus,
  action: TicketAction,
): AccessTicketStatus {
  const next = ticketTransitions[status]?.[action];
  if (!next)
    throw new FacilityError(
      "TICKET_TRANSITION_INVALID",
      `Tiket berstatus ${status} tidak dapat menjalani ${action}.`,
    );
  return next;
}

/**
 * FAC-01: opening a ticket starts its session once. A second open inside the
 * same session changes nothing (re-entry is allowed); opening it in another
 * session is impossible because the ticket belongs to one slot and one unit.
 */
export function openTicketSession(
  ticket: AccessTicket,
  openedAt: Date | string,
): AccessTicket {
  assertTicketUsableAt(ticket, openedAt);
  const time = toIsoDateTime(
    typeof openedAt === "string" ? new Date(openedAt) : openedAt,
  );
  if (ticket.status === "in_use") return ticket;
  return {
    ...ticket,
    status: transitionTicket(ticket.status, "open"),
    firstOpenedAt: time,
  };
}

// ---- Overtime ---------------------------------------------------------------

export const overtimeResultSchema = z.strictObject({
  /** Minutes past `endsAt`, counted per started minute (0 when on time). */
  overtimeMinutes: z.number().int().min(0).max(1440),
  /** Minutes charged after the tolerance. */
  chargeableMinutes: z.number().int().min(0).max(1440),
  blocks: z.number().int().min(0).max(1440),
  feeIdr: idrSchema.refine((value) => value >= 0),
});
export type OvertimeResult = z.infer<typeof overtimeResultSchema>;

/**
 * PRD §3 F22: overtime is recorded and may be charged "sesuai konfigurasi,
 * dengan toleransi yang dapat diatur". Minutes are counted per started minute,
 * the tolerance is free, and every started block after it is charged once.
 */
export function computeOvertime(
  policy: OvertimePolicy,
  input: { scheduledEndsAt: string; endedAt: string },
): OvertimeResult {
  const end = Date.parse(input.scheduledEndsAt);
  const actual = Date.parse(input.endedAt);
  if (Number.isNaN(end) || Number.isNaN(actual))
    throw new RangeError("Invalid overtime instants");
  const overtimeMinutes =
    actual <= end ? 0 : Math.ceil((actual - end) / MINUTE);
  const chargeableMinutes = Math.max(0, overtimeMinutes - policy.graceMinutes);
  const blocks =
    chargeableMinutes === 0
      ? 0
      : Math.ceil(chargeableMinutes / policy.blockMinutes);
  return overtimeResultSchema.parse({
    overtimeMinutes,
    chargeableMinutes,
    blocks,
    feeIdr: blocks === 0 ? 0 : multiplyIdr(policy.feePerBlockIdr, blocks),
  });
}

/**
 * FAC-10: the breakfast order is held and fired `fireOffsetMinutes` before the
 * session ends (the offset is the menu prep time). Recompute it when the
 * session is extended or the guest is late.
 */
export function linkedOrderFireAt(
  ticket: AccessTicket,
  fireOffsetMinutes: number,
): string {
  if (
    !Number.isInteger(fireOffsetMinutes) ||
    fireOffsetMinutes < 0 ||
    fireOffsetMinutes > 240
  )
    throw new RangeError(`Invalid fire offset: ${fireOffsetMinutes}`);
  const endsAt = Date.parse(ticket.slot.endsAt);
  return toIsoDateTime(new Date(endsAt - fireOffsetMinutes * MINUTE));
}

/**
 * Ends an in-use session, recording overtime and its fee. Idempotent for an
 * already completed ticket (a retried edge event does not charge twice).
 */
export function endTicketSession(
  ticket: AccessTicket,
  endedAt: Date | string,
  policy: OvertimePolicy,
): AccessTicket {
  if (ticket.status === "completed") return ticket;
  const time = toIsoDateTime(
    typeof endedAt === "string" ? new Date(endedAt) : endedAt,
  );
  const overtime = computeOvertime(policy, {
    scheduledEndsAt: ticket.slot.endsAt,
    endedAt: time,
  });
  return {
    ...ticket,
    status: transitionTicket(ticket.status, "end"),
    endedAt: time,
    overtimeMinutes: overtime.overtimeMinutes,
    overtimeFeeIdr: overtime.feeIdr,
  };
}

/**
 * A ticket is a no-show only after its whole session passed without a first
 * open (PRD §3 F22 "no-show hangus sesuai kebijakan"). Marking early would
 * deny a guest who arrives inside the window.
 */
export function canMarkNoShow(
  ticket: AccessTicket,
  at: Date | string,
): boolean {
  if (ticket.status !== "issued" || ticket.firstOpenedAt !== null) return false;
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  return time >= Date.parse(ticket.slot.endsAt);
}

// ---- Cancellation -----------------------------------------------------------

export const cancellationOutcomeSchema = z.strictObject({
  resolution: z.enum([
    "entitlement_restored",
    "refund_full",
    "refund_partial",
    "no_refund",
  ]),
  /** Amount kept by the house for a partial refund (0 otherwise). */
  feeIdr: idrSchema.refine((value) => value >= 0),
});
export type CancellationOutcome = z.infer<typeof cancellationOutcomeSchema>;

/**
 * PRD §3 F22 "Pembatalan & Pengembalian": cancelling before the slot returns
 * the access right or refunds; inside the free window is configured. The
 * refunded amount itself comes from the payment intent (WS-05); this function
 * only decides the resolution and the fee, so money math stays in one place.
 */
export function cancellationOutcome(
  policy: CancellationPolicy,
  ticket: AccessTicket,
  at: Date | string,
): CancellationOutcome {
  if (ticket.status !== "issued" && ticket.status !== "pending_payment")
    throw new FacilityError(
      "TICKET_TRANSITION_INVALID",
      "Hanya tiket yang belum dipakai dapat dibatalkan.",
    );
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  const startsAt = Date.parse(ticket.slot.startsAt);
  if (time >= startsAt)
    throw new FacilityError(
      "TICKET_TRANSITION_INVALID",
      "Sesi sudah dimulai; tiket tidak dapat dibatalkan.",
    );
  const late = time >= startsAt - policy.freeCancelMinutesBefore * MINUTE;
  // Nothing has been paid or redeemed on a pending-payment ticket yet.
  if (ticket.status === "pending_payment")
    return cancellationOutcomeSchema.parse({
      resolution: "no_refund",
      feeIdr: 0,
    });
  const resolution: CancellationResolution = late
    ? policy.lateCancelResolution
    : ticket.entitlementLedgerId !== null
      ? "entitlement_restored"
      : "refund_full";
  return cancellationOutcomeSchema.parse({
    resolution,
    feeIdr: resolution === "refund_partial" ? policy.lateCancelFeeIdr : 0,
  });
}

// ---- Unit status machine ----------------------------------------------------

export type UnitAction =
  | "start_session"
  | "end_session"
  | "start_cleaning"
  | "complete_cleaning"
  | "flag_maintenance"
  | "release_maintenance";

const unitTransitions: Record<
  FacilityUnitStatus,
  Partial<Record<UnitAction, FacilityUnitStatus>>
> = {
  available: {
    start_session: "in_use",
    flag_maintenance: "maintenance",
    // A unit that was just released for booking may already need a clean.
    start_cleaning: "cleaning",
  },
  in_use: { end_session: "needs_cleaning", flag_maintenance: "maintenance" },
  needs_cleaning: {
    start_cleaning: "cleaning",
    flag_maintenance: "maintenance",
  },
  cleaning: {
    complete_cleaning: "available",
    flag_maintenance: "maintenance",
  },
  // FAC-06: a released unit still has to be cleaned before it can be booked.
  maintenance: { release_maintenance: "needs_cleaning" },
};

export function canTransitionUnit(
  status: FacilityUnitStatus,
  action: UnitAction,
): boolean {
  return unitTransitions[status]?.[action] !== undefined;
}

export function transitionUnit(
  status: FacilityUnitStatus,
  action: UnitAction,
): FacilityUnitStatus {
  const next = unitTransitions[status]?.[action];
  if (!next)
    throw new FacilityError(
      "UNIT_NOT_BOOKABLE",
      `Bilik berstatus ${status} tidak dapat menjalani ${action}.`,
    );
  return next;
}

/**
 * FAC-06: only a clean, available unit can be booked. A unit that needs
 * cleaning or is under maintenance is refused, no matter which slot is asked
 * for; the booking service checks this inside the same transaction as the
 * exclusion constraint.
 */
export function isUnitBookable(status: FacilityUnitStatus): boolean {
  return status === "available";
}

export function assertUnitBookable(status: FacilityUnitStatus): void {
  if (!isUnitBookable(status))
    throw new FacilityError(
      "UNIT_NOT_BOOKABLE",
      "Bilik ini belum bersih atau sedang dalam perawatan.",
    );
}

// ---- Cleaning task machine --------------------------------------------------

export const cleaningTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
]);
export type CleaningTaskStatus = z.infer<typeof cleaningTaskStatusSchema>;

export function cleaningTaskStatus(task: CleaningTask): CleaningTaskStatus {
  if (task.completedAt !== null) return "done";
  return task.startedAt === null ? "pending" : "in_progress";
}

export function startCleaningCycle(
  task: CleaningTask,
  at: Date | string,
  assignedTo: string | null = null,
): CleaningTask {
  if (cleaningTaskStatus(task) === "done")
    throw new FacilityError("ALREADY_CLOSED", "Tugas ini sudah selesai.");
  return {
    ...task,
    startedAt: toIsoDateTime(typeof at === "string" ? new Date(at) : at),
    assignedTo: assignedTo ?? task.assignedTo,
  };
}

/**
 * Finishes a cleaning cycle. Every checklist item must be done: the unit only
 * returns to `available` after a complete checklist (PRD §3 F22 Siklus
 * Kebersihan, FAC-06).
 */
export function completeCleaningCycle(
  task: CleaningTask,
  at: Date | string,
  input: { checklist: CleaningChecklist; mediaIds?: readonly string[] },
): CleaningTask {
  if (cleaningTaskStatus(task) === "done")
    throw new FacilityError("ALREADY_CLOSED", "Tugas ini sudah selesai.");
  if (task.startedAt === null)
    throw new FacilityError(
      "CLEANING_CHECKLIST_INCOMPLETE",
      "Mulai tugas kebersihan sebelum menyelesaikannya.",
    );
  const checklist = cleaningChecklistSchema.parse(input.checklist);
  if (checklist.some((item) => !item.done))
    throw new FacilityError(
      "CLEANING_CHECKLIST_INCOMPLETE",
      "Selesaikan seluruh checklist kebersihan terlebih dahulu.",
    );
  return {
    ...task,
    checklist,
    mediaIds: [...(input.mediaIds ?? task.mediaIds)],
    completedAt: toIsoDateTime(typeof at === "string" ? new Date(at) : at),
  };
}

// ---- Subscription machine ---------------------------------------------------

export type SubscriptionAction =
  | "payment_paid"
  | "payment_overdue"
  | "suspend"
  | "pause"
  | "resume"
  | "cancel";

const subscriptionTransitions: Record<
  FacilitySubscriptionStatus,
  Partial<Record<SubscriptionAction, FacilitySubscriptionStatus>>
> = {
  active: {
    payment_overdue: "past_due",
    pause: "paused",
    suspend: "suspended",
    cancel: "cancelled",
  },
  // FAC-07: a paid overdue bill returns the plan to active immediately.
  past_due: {
    payment_paid: "active",
    suspend: "suspended",
    cancel: "cancelled",
  },
  suspended: { payment_paid: "active", cancel: "cancelled" },
  paused: { resume: "active", cancel: "cancelled" },
  cancelled: {},
};

export function canTransitionSubscription(
  status: FacilitySubscriptionStatus,
  action: SubscriptionAction,
): boolean {
  return subscriptionTransitions[status]?.[action] !== undefined;
}

export function transitionSubscription(
  status: FacilitySubscriptionStatus,
  action: SubscriptionAction,
): FacilitySubscriptionStatus {
  const next = subscriptionTransitions[status]?.[action];
  if (!next)
    throw new FacilityError(
      "SUBSCRIPTION_QUOTA_UNAVAILABLE",
      `Langganan berstatus ${status} tidak dapat menjalani ${action}.`,
    );
  return next;
}

/**
 * FAC-07: a subscription whose bill is unpaid past its grace period may not
 * use its quota until it is paid. Inside the grace period the quota still
 * works (PRD §3 F22 Langganan Bulanan, default grace 3 days).
 */
export function subscriptionQuotaState(
  subscription: FacilitySubscription,
  at: Date | string,
): SubscriptionQuota {
  const parsed = facilitySubscriptionSchema.parse(subscription);
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  const remaining = Math.max(0, parsed.quotaPerPeriod - parsed.quotaUsed);
  const base = {
    perPeriod: parsed.quotaPerPeriod,
    used: parsed.quotaUsed,
    remaining,
  };
  switch (parsed.status) {
    case "cancelled":
      return { ...base, usable: false, reason: "cancelled" };
    case "suspended":
      return { ...base, usable: false, reason: "suspended" };
    case "paused":
      return { ...base, usable: false, reason: "paused" };
    case "past_due": {
      const withinGrace =
        parsed.graceUntil !== null && time < Date.parse(parsed.graceUntil);
      if (!withinGrace)
        return { ...base, usable: false, reason: "past_due_grace_expired" };
      if (remaining === 0)
        return { ...base, usable: false, reason: "quota_exhausted" };
      return { ...base, usable: true, reason: "past_due_within_grace" };
    }
    case "active":
      if (remaining === 0)
        return { ...base, usable: false, reason: "quota_exhausted" };
      return { ...base, usable: true, reason: "ok" };
  }
}

/**
 * Sessions already consumed on one business date (subscription max-per-day).
 * The day follows the outlet business-day cutoff (owner Q39), so a 01:00
 * session after a late night counts toward the previous business date.
 */
export function sessionsOnBusinessDate(
  tickets: readonly AccessTicket[],
  input: {
    businessDate: string;
    customerProfileId: string;
    clock: BusinessDayClock;
  },
): number {
  return tickets.filter(
    (ticket) =>
      ticket.customerProfileId === input.customerProfileId &&
      (ticket.status === "issued" ||
        ticket.status === "in_use" ||
        ticket.status === "completed") &&
      businessDateOf(ticket.slot.startsAt, input.clock) === input.businessDate,
  ).length;
}

// ---- Incidents (FAC-08) -----------------------------------------------------

/**
 * FAC-08: the emergency button must reach the staff on duty within 5 seconds,
 * including when the outlet network is down (the edge raises the alert
 * locally and syncs the incident later, hence `offline`).
 */
export const PANIC_RESPONSE_TARGET_SECONDS = 5;

export function panicResponseDeadline(triggeredAt: Date | string): string {
  const time =
    typeof triggeredAt === "string"
      ? Date.parse(triggeredAt)
      : triggeredAt.getTime();
  return toIsoDateTime(new Date(time + PANIC_RESPONSE_TARGET_SECONDS * 1_000));
}

/** True only when the incident was answered inside the 5-second target. */
export function isPanicResponseOnTime(incident: {
  triggeredAt: string;
  respondedAt: string | null;
}): boolean {
  if (incident.respondedAt === null) return false;
  return (
    Date.parse(incident.respondedAt) - Date.parse(incident.triggeredAt) <=
    PANIC_RESPONSE_TARGET_SECONDS * 1_000
  );
}

export function respondToFacilityIncident(
  incident: FacilityIncident,
  input: {
    respondedBy: string;
    respondedAt: Date | string;
    resolution: string;
  },
): FacilityIncident {
  if (incident.respondedAt !== null)
    throw new FacilityError("ALREADY_CLOSED", "Insiden ini sudah ditangani.");
  return {
    ...incident,
    respondedBy: input.respondedBy,
    respondedAt: toIsoDateTime(
      typeof input.respondedAt === "string"
        ? new Date(input.respondedAt)
        : input.respondedAt,
    ),
    resolution: input.resolution,
  };
}
