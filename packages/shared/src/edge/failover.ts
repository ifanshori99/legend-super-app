// Edge -> cloud failover contract (1271 F1; docs/design/edge-cloud-failover.md
// and docs/briefs/1271-edge-failover-cards.md decisions D1-D6).
//
// When an outlet's edge is down, a manager opens a failover window in the
// cloud. While it is `active` the cloud sells for the outlet's terminals on a
// cloud-only `F<n>` receipt run. At return the cashier counts each drawer
// again; the closing event tells the edge to close the interrupted edge shift
// with the switchover count (D2: close and reopen, no bridge cash movement).
// Failover orders and shifts stay cloud-only (D1).
//
// States move forward only: active -> returning -> closed, or
// active -> cancelled. At most one `active`/`returning` window per outlet.

import {
  z,
  businessDateSchema,
  clientInputSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import {
  blindCountsSchema,
  orderIdSchema,
  posShiftIdSchema,
} from "../pos/schemas.ts";

export const FAILOVER_WINDOW_STATUSES = [
  "active",
  "returning",
  "closed",
  "cancelled",
] as const;
export const failoverWindowStatusSchema = z.enum(FAILOVER_WINDOW_STATUSES);
export type FailoverWindowStatus = z.infer<typeof failoverWindowStatusSchema>;

/** `active` or `returning`: the edge refuses POS writes and Tutup Hari (D4, D5). */
export function isFailoverWindowOpen(status: FailoverWindowStatus): boolean {
  return status === "active" || status === "returning";
}

/** Activation needs the edge heartbeat at least this old, unless overridden. */
export const FAILOVER_STALE_HEARTBEAT_MS = 120_000;
/** Return needs an edge heartbeat younger than this. */
export const FAILOVER_RETURN_FRESH_HEARTBEAT_MS = 60_000;

export const failoverWindowIdSchema = uuidSchema;

const reasonSchema = z.string().trim().min(3).max(500);

/** One failover window as the cloud returns it and sends it to the edge. */
export const failoverWindowSchema = z.strictObject({
  id: failoverWindowIdSchema,
  outletId: outletIdSchema,
  /** The active primary edge node when the window was opened. */
  edgeNodeId: uuidSchema,
  status: failoverWindowStatusSchema,
  reason: z.string().min(3).max(500),
  /** Opened although the edge heartbeat was fresh (owner is notified). */
  override: z.boolean(),
  activatedBy: userIdSchema,
  activatedAt: isoDateTimeSchema,
  /** Last edge heartbeat the cloud had seen when the window was opened. */
  edgeHeartbeatAt: isoDateTimeSchema.nullable(),
  /** Business date of the outlet when the window was opened. */
  businessDateFrom: businessDateSchema,
  /** Business date when the window left `active`; null while active. */
  businessDateTo: businessDateSchema.nullable(),
  returnStartedAt: isoDateTimeSchema.nullable(),
  /** Set with `returnStartedAt` (the edge copy stores it as received). */
  returnStartedBy: userIdSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  cancelledBy: userIdSchema.nullable(),
});
export type FailoverWindow = z.infer<typeof failoverWindowSchema>;

/**
 * Whether a business date may hold failover rows of this window: from the
 * opening date to the date it left `active` (still open = no upper end).
 * ISO dates compare as strings.
 */
export function windowTouchesDate(
  window: Pick<FailoverWindow, "businessDateFrom" | "businessDateTo">,
  businessDate: string,
): boolean {
  businessDateSchema.parse(businessDate);
  if (businessDate < window.businessDateFrom) return false;
  return (
    window.businessDateTo === null || businessDate <= window.businessDateTo
  );
}

// ---- Request bodies (cloud routes, F3) -------------------------------------

/** Open a window. `reason` is always required; `override` skips the heartbeat check. */
export const activateFailoverWindowInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  reason: reasonSchema,
  override: z.boolean().default(false),
  idempotencyKey: idempotencyKeySchema,
});
export type ActivateFailoverWindowInput = z.infer<
  typeof activateFailoverWindowInputSchema
>;

/** Cancel a window opened by mistake (only with zero failover orders). */
export const cancelFailoverWindowInputSchema = clientInputSchema({
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type CancelFailoverWindowInput = z.infer<
  typeof cancelFailoverWindowInputSchema
>;

/** Start the return to the edge (heartbeat fresh, no open failover work). */
export const startFailoverReturnInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});
export type StartFailoverReturnInput = z.infer<
  typeof startFailoverReturnInputSchema
>;

/** What still blocks the return (`FAILOVER_OPEN_WORK`). */
export const failoverOpenWorkSchema = z.strictObject({
  unpaidOrderIds: z.array(orderIdSchema).max(500),
  openShiftIds: z.array(posShiftIdSchema).max(500),
  qrisHoldOrderIds: z.array(orderIdSchema).max(500),
});
export type FailoverOpenWork = z.infer<typeof failoverOpenWorkSchema>;

// ---- Cloud -> edge events (aggregate `pos_failover_window`) ---------------

export const FAILOVER_WINDOW_AGGREGATE = "pos_failover_window";

/** Full window state (master data, cloud wins); sent on every transition. */
export const failoverWindowStatePayloadSchema = z.strictObject({
  window: failoverWindowSchema,
});
export type FailoverWindowStatePayload = z.infer<
  typeof failoverWindowStatePayloadSchema
>;

/**
 * Switchover count C1 of one device's interrupted edge shift (D2). The edge
 * force-closes that shift with this count; the total is the count sheet's sum.
 */
export const failoverSwitchoverShiftSchema = z
  .strictObject({
    deviceId: uuidSchema,
    cashierId: userIdSchema,
    countedAt: isoDateTimeSchema,
    counts: blindCountsSchema,
    totalIdr: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (shift) =>
      shift.totalIdr ===
      shift.counts.reduce(
        (sum, row) => sum + row.denominationIdr * row.quantity,
        0,
      ),
    { message: "totalIdr must equal the count sheet", path: ["totalIdr"] },
  );
export type FailoverSwitchoverShift = z.infer<
  typeof failoverSwitchoverShiftSchema
>;

/**
 * The window-closing event: the last event of the window. The edge closes the
 * listed shifts, marks its copy `status` and lifts the block, in one
 * transaction; a replay is a no-op by event id.
 */
export const failoverWindowClosedPayloadSchema = z.strictObject({
  windowId: failoverWindowIdSchema,
  status: z.enum(["closed", "cancelled"]),
  businessDates: z.array(businessDateSchema).max(31),
  shifts: z
    .array(failoverSwitchoverShiftSchema)
    .max(100)
    .refine(
      (shifts) =>
        new Set(shifts.map((shift) => shift.deviceId)).size === shifts.length,
      { message: "One switchover count per device" },
    ),
});
export type FailoverWindowClosedPayload = z.infer<
  typeof failoverWindowClosedPayloadSchema
>;

export const failoverWindowStateEvent = defineDomainEvent({
  name: "pos_failover_window.state",
  payload: failoverWindowStatePayloadSchema,
});
export const failoverWindowClosedEvent = defineDomainEvent({
  name: "pos_failover_window.closed",
  payload: failoverWindowClosedPayloadSchema,
});

/** The outlet's current window as the edge status DTO shows it (F4 fills it). */
export const edgeNodeFailoverStatusSchema = z.strictObject({
  windowId: failoverWindowIdSchema,
  status: failoverWindowStatusSchema,
  activatedAt: isoDateTimeSchema,
});
export type EdgeNodeFailoverStatus = z.infer<
  typeof edgeNodeFailoverStatusSchema
>;
