// Open-bill controls (PRD v1.7 §3 F43 "Kontrol Open Bill"; bead legend-cqrw):
// a bill value limit per session, a waiter alert when an open-bill session is
// idle, and the bill-request SLO. The policy is per outlet; a missing policy
// row never means "no limit" (the API service falls back to named defaults).
//
// Bill-request SLO: the alert for a bill request nobody handled is the
// existing `service_request.overdue` sweep (services/service-request.service.ts).
// For `request_bill` the sweep reads `billRequestSloSeconds` from the outlet
// policy (180 s when no row exists); other request types keep the sweep's own
// threshold. Do not add a second alert for the same condition.

import {
  z,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import { staffPinPattern } from "../identity/schemas.ts";
import {
  floorZoneIdSchema,
  tableIdSchema,
  tableSessionIdSchema,
} from "./schemas.ts";

/** Bounds a manager may set; the defaults live in the API service. */
export const OPEN_BILL_MAX_VALUE_FLOOR_IDR = 100_000;
export const OPEN_BILL_MAX_VALUE_CEILING_IDR = 1_000_000_000;
export const OPEN_BILL_INACTIVITY_MINUTES_MIN = 5;
export const OPEN_BILL_INACTIVITY_MINUTES_MAX = 720;
export const OPEN_BILL_SLO_SECONDS_MIN = 30;
export const OPEN_BILL_SLO_SECONDS_MAX = 3600;

export const openBillPolicySchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  /** Most an open-bill session may owe unpaid (credit exposure), whole rupiah. */
  maxBillValueIdr: idrSchema.refine(
    (value) =>
      value >= OPEN_BILL_MAX_VALUE_FLOOR_IDR &&
      value <= OPEN_BILL_MAX_VALUE_CEILING_IDR,
    "Batas nilai tagihan di luar rentang yang diizinkan",
  ),
  /** Idle minutes before the zone waiters are alerted. */
  inactivityMinutes: z
    .number()
    .int()
    .min(OPEN_BILL_INACTIVITY_MINUTES_MIN)
    .max(OPEN_BILL_INACTIVITY_MINUTES_MAX),
  /** Seconds a bill request may wait before it counts as overdue. */
  billRequestSloSeconds: z
    .number()
    .int()
    .min(OPEN_BILL_SLO_SECONDS_MIN)
    .max(OPEN_BILL_SLO_SECONDS_MAX),
  /** False when no row exists and the service defaults apply. */
  isDefault: z.boolean(),
});
export type OpenBillPolicy = z.infer<typeof openBillPolicySchema>;

export const upsertOpenBillPolicyInputSchema = openBillPolicySchema.pick({
  maxBillValueIdr: true,
  inactivityMinutes: true,
  billRequestSloSeconds: true,
});
export type UpsertOpenBillPolicyInput = z.infer<
  typeof upsertOpenBillPolicyInputSchema
>;

/**
 * A supervisor+ turns a running pay-first session into an open bill (founder
 * Q31/Q32, Q33/Q34). Every staff member sees the button; it only works with the
 * PIN of an approver who holds `floor.session.open_bill` in the outlet. The PIN
 * is checked per person (like the AUTH-06 override), so the body names the
 * approver. The approver may be the requester (a logged-in supervisor entering
 * their own PIN is a step-up); unlike AUTH-06 overrides this is allowed.
 */
export const convertSessionToOpenBillInputSchema = z.strictObject({
  reason: z.string().trim().min(3).max(300),
  approverUserId: userIdSchema,
  pin: z.string().regex(staffPinPattern, "Expected a 6-digit pin"),
});
export type ConvertSessionToOpenBillInput = z.infer<
  typeof convertSessionToOpenBillInputSchema
>;

/** Staff who may approve a conversion in an outlet and have an active PIN. */
export const openBillApproverSchema = z.strictObject({
  userId: userIdSchema,
  displayName: z.string().min(1),
});
export type OpenBillApprover = z.infer<typeof openBillApproverSchema>;

/** A placed order would push the session over its limit (409). */
export const QR_ORDER_OPEN_BILL_LIMIT = "QR_ORDER_OPEN_BILL_LIMIT" as const;
/** Unpaid bill is already at or over the outlet limit: no conversion (409). */
export const OPEN_BILL_CONVERT_LIMIT = "OPEN_BILL_CONVERT_LIMIT" as const;
/** The named approver does not hold the permission in this outlet (403). */
export const OPEN_BILL_APPROVER_DENIED = "OPEN_BILL_APPROVER_DENIED" as const;
/** The session is not a running pay-first session (409). */
export const OPEN_BILL_NOT_ELIGIBLE = "OPEN_BILL_NOT_ELIGIBLE" as const;
export const openBillErrorHttpStatus = {
  [QR_ORDER_OPEN_BILL_LIMIT]: 409,
  [OPEN_BILL_CONVERT_LIMIT]: 409,
  [OPEN_BILL_APPROVER_DENIED]: 403,
  [OPEN_BILL_NOT_ELIGIBLE]: 409,
} as const satisfies Record<string, number>;
export const openBillErrorMessages = {
  [QR_ORDER_OPEN_BILL_LIMIT]:
    "Batas nilai tagihan open bill untuk meja ini sudah tercapai. Mohon minta waiter atau kasir membantu menyelesaikan tagihan sebelum memesan lagi.",
  [OPEN_BILL_CONVERT_LIMIT]:
    "Tagihan belum dibayar sudah mencapai batas open bill outlet. Minta tamu membayar sebagian dulu.",
  [OPEN_BILL_APPROVER_DENIED]:
    "Penyetuju ini tidak berwenang menyetujui open bill di outlet ini.",
  [OPEN_BILL_NOT_ELIGIBLE]:
    "Meja ini bukan sesi bayar dulu yang sedang berjalan.",
} as const;

export const openBillInactivePayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  zoneId: floorZoneIdSchema,
  /** Session activity time the alert is for: one alert per idle spell. */
  lastActivityAt: isoDateTimeSchema,
  idleMinutes: z.number().int().nonnegative(),
  thresholdMinutes: z.number().int().positive(),
});

export const openBillLimitExceededPayloadSchema = z.strictObject({
  sessionId: tableSessionIdSchema,
  tableId: tableIdSchema,
  zoneId: floorZoneIdSchema,
  /** Cart being checked out; one breach record per session and version. */
  cartVersion: z.number().int().nonnegative(),
  currentBillIdr: idrSchema.refine((value) => value >= 0),
  attemptedOrderIdr: idrSchema.refine((value) => value >= 0),
  maxBillValueIdr: idrSchema.refine((value) => value >= 0),
  /** True when the outlet had no stored policy and the default applied. */
  policyIsDefault: z.boolean(),
});

export const openBillEvents = {
  "open_bill.inactive": defineDomainEvent({
    name: "open_bill.inactive",
    payload: openBillInactivePayloadSchema,
  }),
  "open_bill.limit_exceeded": defineDomainEvent({
    name: "open_bill.limit_exceeded",
    payload: openBillLimitExceededPayloadSchema,
  }),
} as const;
