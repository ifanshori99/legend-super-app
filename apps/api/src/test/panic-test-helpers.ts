// Shared constants for the emergency-button tests (legend-bod.1, design
// docs/design/edge-emergency.md). Everything the design leaves open is named
// here ONCE so the implementation card (E1-E4) can adjust a single file.
// This file must not import production code that does not exist yet.

/** Routes: edge.md D-03, D-06, D-07, D-11. */
export const PANIC_ROUTES = {
  press: "/api/emergency/press",
  sessions: "/api/emergency/sessions",
  sessionCurrent: "/api/emergency/sessions/current",
  ack: (alertId: string) =>
    `/api/emergency/alerts/${encodeURIComponent(alertId)}/ack`,
  ws: "/api/emergency/ws",
  // Cloud manager routes (D-07, D-11). The exact resolve/ack sub-paths are an
  // ASSUMPTION: the design only fixes the prefix `/api/outlets/:outletId/emergency-alerts`.
  cloudList: (outletId: string) =>
    `/api/outlets/${encodeURIComponent(outletId)}/emergency-alerts`,
  cloudResolve: (outletId: string, alertId: string) =>
    `/api/outlets/${encodeURIComponent(outletId)}/emergency-alerts/${encodeURIComponent(alertId)}/resolve`,
  cloudAck: (outletId: string, alertId: string) =>
    `/api/outlets/${encodeURIComponent(outletId)}/emergency-alerts/${encodeURIComponent(alertId)}/ack`,
} as const;

export const PANIC_WS_PROTOCOL = "legend.emergency.v1"; // D-03 step 4
export const PANIC_COOKIE_NAME = "legend_emergency"; // D-03 step 3
export const PANIC_REVOKED_CLOSE_CODE = 4401; // D-03 revocation
export const PANIC_PERMISSION_RESPOND = "facility.emergency.respond"; // D-02
export const PANIC_PERMISSION_RESOLVE = "facility.emergency.resolve"; // D-07
export const PANIC_ERR_NOT_ON_DUTY = "NOT_ON_DUTY"; // D-04

/** Timing from the design (not open questions). */
export const PANIC_DELIVERY_BUDGET_MS = 5_000; // FAC-08 / D-05
export const PANIC_RESEND_INTERVAL_MS = 3_000; // D-05
/**
 * Upper bound a test waits for a frame or a DB receipt that it does not itself
 * time. Not the FAC-08 SLO (PANIC_DELIVERY_BUDGET_MS, asserted only by the
 * tests that measure it): the WS + DB chain can pass 5 s under full-suite load.
 * Must stay below the 20 s default test timeout (vitest.config.ts).
 */
export const PANIC_TEST_WAIT_MS = 15_000;
export const PANIC_PRESS_FOLD_WINDOW_MS = 60_000; // D-06
export const PANIC_PRESS_RATE_LIMIT_PER_MIN = 30; // D-06
export const PANIC_DEVICE_PIN_WRONG_LIMIT = 10; // staff-pin-proof, per device / 5 min
export const PANIC_STAFF_PIN_WRONG_LOCK = 5; // MAX_STAFF_PIN_ATTEMPTS, lock 15 min
export const PANIC_MAX_CLOCK_IN_DUTY_HOURS = 14; // D-04 (b)
export const PANIC_SHIFT_GRACE_MINUTES = 30; // D-04 (a)

/**
 * QE1 = Q94, ANSWERED by founder (13 Nov 2026): no staff receipt within 15 s
 * -> the alarm also shows on ALL POS screens of that outlet, with room name +
 * time only (no other detail). Tests EM-14, EM-19 assert exactly this.
 */
export const PANIC_FALLBACK_AFTER_MS = 15_000; // Q94 answered
export const PANIC_FALLBACK_ENABLED = true; // Q94 answered: yes
export const PANIC_FALLBACK_FIELDS = ["unitCode", "receivedAt"] as const; // room name + time only

/**
 * QE2 = Q95, ANSWERED by founder (13 Nov 2026): receivers are on-duty
 * facility attendant, supervisor, outlet manager, general manager. Cashier and
 * kitchen do NOT receive (they only see the POS fallback). Only outlet manager
 * and general manager close an incident, in the cloud. Tests assert the
 * permission `facility.emergency.respond` (D-02) is held by the four receiver
 * roles and NOT by cashier/kitchen roles, and `facility.emergency.resolve` only
 * by outlet_manager + general_manager.
 */
export const PANIC_RECEIVER_ROLES = [
  "facility_attendant",
  "supervisor",
  "outlet_manager",
  "general_manager",
] as const;
export const PANIC_NON_RECEIVER_ROLES = ["cashier", "kitchen"] as const; // role slugs: verify against packages/shared access/roles.ts
export const PANIC_RESOLVER_ROLES = [
  "outlet_manager",
  "general_manager",
] as const;

/** Body builders. The session body is an ASSUMPTION (the shared Zod does not exist yet). */
export function pressBody(
  eventId: string,
  extra: { triggeredAt?: string; kind?: "press" | "test" } = {},
) {
  return { eventId, kind: extra.kind ?? "press", ...extra };
}

export function sessionBody(staffUserId: string, pin: string) {
  // ASSUMPTION: field names. Adjust here when the E1 contract is written.
  return { staffUserId, pin };
}

/**
 * Real-WebSocket seam (added by part E1). ASSUMPTION: the design fixes the
 * socket path, subprotocol and cookie but not how the socket is attached to an
 * http server. Tests attach it with
 * `(await import(PANIC_REALTIME_ATTACH.module))[PANIC_REALTIME_ATTACH.exportName](server, { trustedOrigins })`
 * (same shape as the draft `attachPanicRealtime`), which returns `{ close() }`.
 * Frames: server to client `{ type: "panic", alertId, outletId, unitId,
 * receivedAt, kind }` (kind "test" = shown with the "UJI" flag), client to
 * server `{ type: "received", alertId }` (D-05).
 */
export const PANIC_REALTIME_ATTACH = {
  module: "../edge/panic-relay-realtime.ts",
  exportName: "attachEmergencyRealtime",
} as const;
export const PANIC_FRAME_ALERT = "panic";
export const PANIC_FRAME_RECEIVED = "received";

/**
 * POS fallback read seam (added by part E1, Q94 answered). ASSUMPTION: a POS
 * screen is a registered `pos` device with its device token and NO staff
 * session (that is the point of the fallback); it reads the alarms that passed
 * PANIC_FALLBACK_AFTER_MS without a staff receipt with
 * `GET PANIC_FALLBACK_ROUTE` (200, `data.alerts[]`, each item with exactly the
 * keys of PANIC_FALLBACK_FIELDS plus `alertId`; nothing else: no device label,
 * no staff, no guest detail). Adjust here once E3 fixes the real channel.
 */
export const PANIC_FALLBACK_ROUTE = "/api/emergency/fallback";
export const PANIC_FALLBACK_ITEM_KEYS = [
  "alertId",
  "unitCode",
  "receivedAt",
] as const;
/** Receiver and non-receiver role template keys (packages/shared access/roles.ts; "kitchen" = these). */
export const PANIC_NON_RECEIVER_TEMPLATES = [
  "cashier",
  "barista_cook",
  "kitchen_lead",
] as const;
