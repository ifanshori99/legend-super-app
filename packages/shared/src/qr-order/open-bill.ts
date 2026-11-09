// Open-bill controls (PRD v1.7 §3 F43 "Kontrol Open Bill"; bead legend-cqrw):
// a bill value limit per session, a waiter alert when an open-bill session is
// idle, and the bill-request SLO. The policy is per outlet; a missing policy
// row never means "no limit" (the API service falls back to named defaults).
//
// Bill-request SLO: the alert for a bill request nobody handled is the
// existing `service_request.overdue` sweep (services/service-request.service.ts,
// 180 s). `billRequestSloSeconds` is stored with the policy but that sweep
// does not read it yet; do not add a second alert for the same condition.

import {
  z,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
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
  /** Seconds a bill request may wait. Stored; see the file comment. */
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

/** A placed order would push the session over its limit (409). */
export const QR_ORDER_OPEN_BILL_LIMIT = "QR_ORDER_OPEN_BILL_LIMIT" as const;
export const openBillErrorHttpStatus = {
  [QR_ORDER_OPEN_BILL_LIMIT]: 409,
} as const satisfies Record<string, number>;
export const openBillErrorMessages = {
  [QR_ORDER_OPEN_BILL_LIMIT]:
    "Batas nilai tagihan open bill untuk meja ini sudah tercapai. Mohon minta waiter atau kasir membantu menyelesaikan tagihan sebelum memesan lagi.",
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
