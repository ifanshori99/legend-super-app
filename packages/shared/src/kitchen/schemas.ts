// Kitchen contract (bead legend-acz) — PRD v1.7 §3 F12 "KDS, Expo & Pickup
// Display" (KDS per stasiun, aksi tiket, all-day count, expo, pickup display,
// analitik serving time, order pacing, estimasi waktu saji, remake & comp) and
// §6 group C tables (`kitchen_tickets`, `kitchen_capacity_rules`,
// `order_issues`, plus `order_items.status`/`fire_status` and `stations`).
//
// Data contract only: authorization, pacing admission and serving-time
// prediction stay in the API (WS-04 BE). What is shared here is the vocabulary
// and the explicit state machines the KDS, expo, pickup display and kitchen
// config screens use, so FE and BE cannot drift (KDS-04 audit trail, KDS-07
// remake/comp record).
//
// `stations` (§6) is owned by the menu contract (bead legend-j85,
// `stationSchema` in @starter/shared/menu). Kitchen adds the per-outlet display
// config, the capacity rules and the per-menu load points that pacing needs.

import {
  z,
  uuidSchema,
  uuidIdSchema,
  ulidIdSchema,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  idempotencyKeySchema,
  idrSchema,
  basisPointsSchema,
  businessDateSchema,
  isoDateTimeSchema,
  timeOfDaySchema,
} from "../core/index.ts";
import { PICKUP_CODE_PATTERN } from "./pickup-code.ts";
import { channelSchema, stationTypeSchema } from "../menu/schemas.ts";

const scope = { tenantId: tenantIdSchema };
const outletScope = { ...scope, outletId: outletIdSchema };
const name = z.string().min(1).max(150);

export const stationIdSchema = uuidIdSchema<"StationId">();
export const kitchenTicketIdSchema = ulidIdSchema<"KitchenTicketId">();
export const kitchenTicketItemIdSchema = ulidIdSchema<"KitchenTicketItemId">();
/** The POS order aggregate (bead legend-4yp) is ULID-keyed; kitchen references it. */
export const orderIdSchema = ulidIdSchema<"OrderId">();
const orderItemIdSchema = ulidIdSchema<"OrderItemId">();

/* ---------------------------------------------------------------- tickets */

/** PRD §6 `kitchen_tickets.status`. */
export const kitchenTicketStatusSchema = z.enum([
  "new",
  "in_progress",
  "done",
  "recalled",
  "cancelled",
]);
/** "Aksi Tiket": mulai, selesai (bump), panggil ulang (recall), batal. */
export const kitchenTicketActionSchema = z.enum([
  "start",
  "bump",
  "recall",
  "void",
]);
export type KitchenTicketStatus = z.infer<typeof kitchenTicketStatusSchema>;
export type KitchenTicketAction = z.infer<typeof kitchenTicketActionSchema>;

/**
 * One explicit transition table for FE and BE (same pattern as menu 86).
 * `done` is not terminal: recall puts the ticket back on the station, and a
 * cancelled ticket never reopens (§6 has no path out of `cancelled`).
 */
export const KITCHEN_TICKET_TRANSITIONS: Record<
  KitchenTicketStatus,
  Partial<Record<KitchenTicketAction, KitchenTicketStatus>>
> = {
  new: { start: "in_progress", void: "cancelled" },
  in_progress: { bump: "done", void: "cancelled" },
  done: { recall: "recalled" },
  recalled: { start: "in_progress", void: "cancelled" },
  cancelled: {},
};

export function canTransitionKitchenTicket(
  status: KitchenTicketStatus,
  action: KitchenTicketAction,
): boolean {
  return KITCHEN_TICKET_TRANSITIONS[status][action] !== undefined;
}

export function transitionKitchenTicket(
  status: KitchenTicketStatus,
  action: KitchenTicketAction,
): KitchenTicketStatus {
  const next = KITCHEN_TICKET_TRANSITIONS[status][action];
  if (next === undefined)
    throw new RangeError(`Ticket cannot ${action} from ${status}`);
  return next;
}

/** `order_items.status` as the KDS shows it (PRD §6). */
export const kitchenItemStatusSchema = z.enum([
  "queued",
  "in_progress",
  "ready",
  "served",
  "voided",
]);
export const kitchenItemActionSchema = z.enum([
  "start",
  "ready",
  "serve",
  "recall",
  "void",
]);
export type KitchenItemStatus = z.infer<typeof kitchenItemStatusSchema>;
export type KitchenItemAction = z.infer<typeof kitchenItemActionSchema>;

/**
 * Item level state machine. `recall` returns a ready item to the station (food
 * came back / was sent to the wrong table); a served or voided item is
 * terminal here — correcting a served line is the POS void/refund flow.
 */
export const KITCHEN_ITEM_TRANSITIONS: Record<
  KitchenItemStatus,
  Partial<Record<KitchenItemAction, KitchenItemStatus>>
> = {
  queued: { start: "in_progress", void: "voided" },
  in_progress: { ready: "ready", void: "voided" },
  ready: { serve: "served", recall: "in_progress", void: "voided" },
  served: {},
  voided: {},
};

export function canTransitionKitchenItem(
  status: KitchenItemStatus,
  action: KitchenItemAction,
): boolean {
  return KITCHEN_ITEM_TRANSITIONS[status][action] !== undefined;
}

export function transitionKitchenItem(
  status: KitchenItemStatus,
  action: KitchenItemAction,
): KitchenItemStatus {
  const next = KITCHEN_ITEM_TRANSITIONS[status][action];
  if (next === undefined)
    throw new RangeError(`Item cannot ${action} from ${status}`);
  return next;
}

const ticketItemShape = {
  ...outletScope,
  id: kitchenTicketItemIdSchema,
  ticketId: kitchenTicketIdSchema,
  orderId: orderIdSchema,
  orderItemId: orderItemIdSchema,
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  name,
  quantity: z.number().int().positive().max(999),
  course: z.string().min(1).max(20).nullable(),
  /** Rendered prominently on KDS: "Less Sugar", "Tanpa Es" (PRD F12). */
  modifiers: z.array(name),
  note: name.nullable(),
  status: kitchenItemStatusSchema,
  firedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  readyAt: isoDateTimeSchema.nullable(),
  servedAt: isoDateTimeSchema.nullable(),
  recalledCount: z.number().int().nonnegative().max(99),
};

const startedItemRule = (item: {
  status: KitchenItemStatus;
  startedAt: string | null;
}) =>
  item.status === "queued" ||
  item.status === "voided" ||
  item.startedAt !== null;
const readyItemRule = (item: {
  status: KitchenItemStatus;
  readyAt: string | null;
}) =>
  item.status === "queued" ||
  item.status === "in_progress" ||
  item.status === "voided" ||
  item.readyAt !== null;
const servedItemRule = (item: {
  status: KitchenItemStatus;
  servedAt: string | null;
}) => item.status !== "served" || item.servedAt !== null;

export const kitchenTicketItemSchema = z
  .strictObject(ticketItemShape)
  .refine(startedItemRule, {
    path: ["startedAt"],
    message: "An in-progress, ready or served item records startedAt (KDS-04)",
  })
  .refine(readyItemRule, {
    path: ["readyAt"],
    message: "A ready or served item records readyAt (KDS-04)",
  })
  .refine(servedItemRule, {
    path: ["servedAt"],
    message: "A served item records servedAt (KDS-04)",
  });

const ticketShape = {
  ...outletScope,
  id: kitchenTicketIdSchema,
  orderId: orderIdSchema,
  stationId: stationIdSchema,
  /** Running number per outlet and business day (KDS scan code K-001). */
  ticketNo: z.number().int().positive(),
  status: kitchenTicketStatusSchema,
  /** SMALLINT: 0 normal, higher is more urgent (§6 `priority`). */
  priority: z.number().int().min(0).max(9),
  firedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  doneAt: isoDateTimeSchema.nullable(),
  servedAt: isoDateTimeSchema.nullable(),
  /** §6 `printed_fallback`: printed because the KDS did not answer. */
  printedFallback: z.boolean(),
};

const startedTicketRule = (ticket: {
  status: KitchenTicketStatus;
  startedAt: string | null;
}) =>
  ticket.status === "new" ||
  ticket.status === "cancelled" ||
  ticket.startedAt !== null;
const finishedTicketRule = (ticket: {
  status: KitchenTicketStatus;
  doneAt: string | null;
}) =>
  (ticket.status !== "done" && ticket.status !== "recalled") ||
  ticket.doneAt !== null;

const ticketSchemaBase = z.strictObject(ticketShape);

export const kitchenTicketSchema = ticketSchemaBase
  .refine(startedTicketRule, {
    path: ["startedAt"],
    message: "A started ticket records startedAt (KDS-04)",
  })
  .refine(finishedTicketRule, {
    path: ["doneAt"],
    message: "A bumped or recalled ticket records doneAt (KDS-04)",
  });

/** What the KDS renders: one ticket per station with its item lines. */
export const kitchenTicketDetailSchema = ticketSchemaBase
  .extend({
    /**
     * legend-rutl: read from the order for the KDS header. The table code when
     * the order sits on a table session, else null (takeaway, delivery).
     */
    tableLabel: z.string().min(1).max(20).nullable(),
    /** The order's menu channel (dine-in or takeaway for own orders). */
    channel: channelSchema,
    items: z.array(kitchenTicketItemSchema).min(1),
  })
  .refine(startedTicketRule, {
    path: ["startedAt"],
    message: "A started ticket records startedAt (KDS-04)",
  })
  .refine(finishedTicketRule, {
    path: ["doneAt"],
    message: "A bumped or recalled ticket records doneAt (KDS-04)",
  });

/**
 * KDS-04: every status change is recorded with time, user/device and source.
 * `source: "system"` covers the printed fallback and automatic cancellation;
 * `actorId` is then null.
 */
export const ticketStatusChangeSchema = z
  .strictObject({
    ...outletScope,
    id: ulidIdSchema<"KitchenTicketEventId">(),
    ticketId: kitchenTicketIdSchema,
    orderId: orderIdSchema,
    stationId: stationIdSchema,
    orderItemId: orderItemIdSchema.nullable(),
    fromStatus: kitchenTicketStatusSchema.nullable(),
    toStatus: kitchenTicketStatusSchema,
    source: z.enum(["user", "device", "system"]),
    actorId: userIdSchema.nullable(),
    deviceId: uuidSchema.nullable(),
    occurredAt: isoDateTimeSchema,
    /** Recall and void carry a written reason; the other transitions may. */
    reason: z.string().min(1).max(200).nullable(),
  })
  .refine((change) => change.source === "system" || change.actorId !== null, {
    path: ["actorId"],
    message: "A user or device status change records the actor (KDS-04)",
  })
  .refine((change) => change.source !== "device" || change.deviceId !== null, {
    path: ["deviceId"],
    message: "A device status change records the device (KDS-04)",
  })
  .refine(
    (change) =>
      (change.toStatus !== "recalled" && change.toStatus !== "cancelled") ||
      change.reason !== null,
    {
      path: ["reason"],
      message: "A recall or cancellation records its reason",
    },
  );

/* --------------------------------------------------------------- stations */

/**
 * Per-outlet KDS configuration for a `stations` row (§6, owned by the menu
 * contract). `displayOrder` is the left-to-right KDS tab order.
 */
export const stationConfigSchema = z.strictObject({
  ...outletScope,
  id: uuidSchema,
  stationId: stationIdSchema,
  displayOrder: z.number().int().nonnegative().max(1000),
  isActive: z.boolean(),
  /** F12 "Fallback Cetak": print automatically when the tablet stops answering. */
  autoPrintFallback: z.boolean(),
});

/**
 * What a station-scoped cook reads about a station (legend-gt7f): the label
 * and the target time the KDS timer needs. Not the menu `Station` row: no
 * printer device, no timestamps, so the read needs only `kds.ticket.process`.
 */
export const stationLabelSchema = z.strictObject({
  stationId: stationIdSchema,
  name: z.string().min(1).max(150),
  type: stationTypeSchema,
  targetSeconds: z.number().int().positive().nullable(),
});

/* ------------------------------------------------------- pacing / capacity */

/** Load points and preparation time per menu line (F12 ordering pacing). */
export const menuLoadSchema = z.strictObject({
  ...outletScope,
  id: uuidSchema,
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  loadPoints: z.number().int().positive().max(100),
  prepSeconds: z.number().int().positive().max(7200),
});

export const capacityScheduleSchema = z.strictObject({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  start: timeOfDaySchema,
  end: timeOfDaySchema,
});

/**
 * PRD §6 `kitchen_capacity_rules`: capacity per station per window, applied in
 * the scheduled hours. Several rules per station cover per-hour pacing (for
 * example a tighter 15-minute window during the dinner peak).
 *
 * `nearCapacityBp` is configuration, not a coded threshold: the level that
 * makes KDS-05 refresh the serving-time estimate and pause long-prep menus.
 * `channelPriority` is an ordered, duplicate-free channel list: dine-in may be
 * served before the delivery channels.
 */
export const capacityRuleSchema = z
  .strictObject({
    ...outletScope,
    id: uuidSchema,
    stationId: stationIdSchema,
    /** PRD F12: capacity per station per 15 minutes. */
    windowMinutes: z.number().int().min(5).max(60),
    capacityPoints: z.number().int().positive().max(10_000),
    nearCapacityBp: basisPointsSchema.refine((bp) => bp > 0, {
      message: "The near-capacity level must be above zero",
    }),
    schedule: z.array(capacityScheduleSchema).min(1),
    channelPriority: z
      .array(channelSchema)
      .min(1)
      .refine((channels) => new Set(channels).size === channels.length, {
        message: "Each channel appears once in the priority list",
      }),
  })
  .refine((rule) => rule.windowMinutes % 5 === 0, {
    path: ["windowMinutes"],
    message: "Capacity windows are a whole number of 5-minute slices",
  });

/**
 * A capacity rule as a cook reads it (legend-gt7f): the pacing facts of one
 * station, without the row id, tenant, outlet or timestamps.
 */
export const stationCapacityRuleSchema = z
  .strictObject({
    stationId: stationIdSchema,
    windowMinutes: z.number().int().min(5).max(60),
    capacityPoints: z.number().int().positive().max(10_000),
    nearCapacityBp: basisPointsSchema.refine((bp) => bp > 0, {
      message: "The near-capacity level must be above zero",
    }),
    schedule: z.array(capacityScheduleSchema).min(1),
    channelPriority: z
      .array(channelSchema)
      .min(1)
      .refine((channels) => new Set(channels).size === channels.length, {
        message: "Each channel appears once in the priority list",
      }),
  })
  .refine((rule) => rule.windowMinutes % 5 === 0, {
    path: ["windowMinutes"],
    message: "Capacity windows are a whole number of 5-minute slices",
  });

/** Everything the rules above accept on the kitchen config screen. */
export const capacityRuleInputSchema = z
  .strictObject({
    windowMinutes: z.number().int().min(5).max(60),
    capacityPoints: z.number().int().positive().max(10_000),
    nearCapacityBp: basisPointsSchema.refine((bp) => bp > 0, {
      message: "The near-capacity level must be above zero",
    }),
    schedule: z.array(capacityScheduleSchema).min(1),
    channelPriority: z
      .array(channelSchema)
      .min(1)
      .refine((channels) => new Set(channels).size === channels.length, {
        message: "Each channel appears once in the priority list",
      }),
  })
  .refine((rule) => rule.windowMinutes % 5 === 0, {
    path: ["windowMinutes"],
    message: "Capacity windows are a whole number of 5-minute slices",
  });

export const capacityLevelSchema = z.enum([
  "available",
  "near_capacity",
  "at_capacity",
]);
export type CapacityLevel = z.infer<typeof capacityLevelSchema>;

/**
 * KDS-05 in one place: at capacity the estimate is refreshed and long-prep
 * menus are paused per channel; near capacity is the supervisor warning zone.
 * Integer math so the boundary never depends on float rounding.
 */
export function capacityLevelFor(
  usedPoints: number,
  capacityPoints: number,
  nearCapacityBp: number,
): CapacityLevel {
  if (!Number.isInteger(usedPoints) || usedPoints < 0)
    throw new RangeError(
      `Used points must be a non-negative integer: ${usedPoints}`,
    );
  if (!Number.isInteger(capacityPoints) || capacityPoints <= 0)
    throw new RangeError(
      `Capacity must be a positive integer: ${capacityPoints}`,
    );
  if (
    !Number.isInteger(nearCapacityBp) ||
    nearCapacityBp < 0 ||
    nearCapacityBp > 10_000
  )
    throw new RangeError(
      `Near-capacity level must be 0..10000 bp: ${nearCapacityBp}`,
    );
  if (usedPoints >= capacityPoints) return "at_capacity";
  if (usedPoints * 10_000 >= capacityPoints * nearCapacityBp)
    return "near_capacity";
  return "available";
}

export const stationPacingSchema = z
  .strictObject({
    ...outletScope,
    stationId: stationIdSchema,
    windowMinutes: z.number().int().min(5).max(60),
    windowStart: isoDateTimeSchema,
    capacityPoints: z.number().int().positive().max(10_000),
    nearCapacityBp: basisPointsSchema.refine((bp) => bp > 0, {
      message: "The near-capacity level must be above zero",
    }),
    usedPoints: z.number().int().nonnegative(),
    queuedItems: z.number().int().nonnegative(),
    status: capacityLevelSchema,
  })
  .refine(
    (pacing) =>
      pacing.status ===
      capacityLevelFor(
        pacing.usedPoints,
        pacing.capacityPoints,
        pacing.nearCapacityBp,
      ),
    {
      path: ["status"],
      message: "Pacing status must match used points against the capacity rule",
    },
  );

export const pacingSnapshotSchema = z.strictObject({
  ...outletScope,
  generatedAt: isoDateTimeSchema,
  stations: z.array(stationPacingSchema),
});

/**
 * F12: a long-prep menu item can be paused for chosen channels while its
 * station is saturated (KDS-05: it cannot be ordered from that channel).
 */
export const channelPauseSchema = z.strictObject({
  ...outletScope,
  id: uuidSchema,
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  channels: z.array(channelSchema).min(1),
  reason: z.enum(["station_capacity", "long_prep", "manual"]),
  pausedUntil: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  createdBy: userIdSchema.nullable(),
});

/**
 * legend-7svpq: kitchen config sets the load of a menu line. One row per
 * outlet and line (item + optional variant); a repeated PUT with the same
 * values is a no-op.
 */
export const menuLoadInputSchema = z.strictObject({
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  loadPoints: z.number().int().positive().max(100),
  prepSeconds: z.number().int().positive().max(7200),
});

/**
 * legend-7svpq: a supervisor pauses a menu line for chosen channels. The
 * automatic pacing never lifts or edits a manual pause. `pausedUntil` null =
 * until released; a past instant is refused.
 */
export const manualChannelPauseInputSchema = z.strictObject({
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  channels: z
    .array(channelSchema)
    .min(1)
    .max(6)
    .refine((channels) => new Set(channels).size === channels.length, {
      message: "Duplicate channel",
    }),
  pausedUntil: isoDateTimeSchema.nullable(),
});

/* ----------------------------------------------------------- all-day count */

/** F12 "All-Day Count": queued quantity per item on one station, for batch prep. */
export const allDayCountRowSchema = z.strictObject({
  stationId: stationIdSchema,
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  name,
  quantity: z.number().int().positive().max(999),
  oldestFiredAt: isoDateTimeSchema,
});

export const allDayCountSchema = z.strictObject({
  ...outletScope,
  stationId: stationIdSchema,
  generatedAt: isoDateTimeSchema,
  rows: z.array(allDayCountRowSchema),
});

/* -------------------------------------------------------------------- expo */

export const expoStationTicketSchema = z.strictObject({
  stationId: stationIdSchema,
  /** Station label from the station row ("Dapur Panas"), so the expo card can
   * name the station without a second lookup (bead legend-zvz). */
  stationName: name,
  ticketId: kitchenTicketIdSchema,
  status: kitchenTicketStatusSchema,
});

/**
 * F12 "Expo": one order across all stations, per table, marked complete when
 * every station ticket is done, with the runner assignment.
 */
export const expoTicketSchema = z
  .strictObject({
    ...outletScope,
    orderId: orderIdSchema,
    channel: channelSchema,
    /** Table label for dine-in; null for pickup and delivery orders. */
    tableLabel: z.string().min(1).max(50).nullable(),
    pickupNumber: z.number().int().positive().nullable(),
    /** The call code of `pickupNumber` (A-001...); null when it has none. */
    pickupCode: z.string().regex(PICKUP_CODE_PATTERN).nullable(),
    stations: z.array(expoStationTicketSchema).min(1),
    isComplete: z.boolean(),
    readyAt: isoDateTimeSchema.nullable(),
    runnerId: userIdSchema.nullable(),
    runnerAssignedAt: isoDateTimeSchema.nullable(),
    /** The runner marked the order delivered (PRD §4 flow D step 4, flow G step 3). */
    deliveredAt: isoDateTimeSchema.nullable(),
  })
  .refine((ticket) => !ticket.isComplete || ticket.readyAt !== null, {
    path: ["readyAt"],
    message: "A complete expo ticket records readyAt",
  })
  .refine(
    (ticket) =>
      (ticket.runnerId === null) === (ticket.runnerAssignedAt === null),
    {
      path: ["runnerAssignedAt"],
      message: "A runner assignment carries its timestamp",
    },
  )
  .refine((ticket) => ticket.deliveredAt === null || ticket.runnerId !== null, {
    path: ["deliveredAt"],
    message: "A delivered order has a runner",
  });

/** Why "diantar" is refused for an expo ticket; null = allowed (or a repeat). */
export type ExpoDeliveryBlock =
  "EXPO_ORDER_NOT_COMPLETE" | "EXPO_RUNNER_NOT_ASSIGNED";

/**
 * Rule for `markExpoOrderDelivered`, shared by FE (enable the button) and BE.
 * Already delivered is a repeat, not a block: the call is idempotent and
 * returns the ticket unchanged (the first `deliveredAt` is kept).
 */
export function expoDeliveryBlock(
  ticket: Pick<ExpoTicket, "isComplete" | "runnerId" | "deliveredAt">,
): ExpoDeliveryBlock | null {
  if (ticket.deliveredAt !== null) return null;
  if (!ticket.isComplete) return "EXPO_ORDER_NOT_COMPLETE";
  if (ticket.runnerId === null) return "EXPO_RUNNER_NOT_ASSIGNED";
  return null;
}

export const expoBoardSchema = z.strictObject({
  ...outletScope,
  generatedAt: isoDateTimeSchema,
  tickets: z.array(expoTicketSchema),
});

/**
 * F12 "menugaskan runner": the staff the expo screen may assign to a table.
 * `assignExpoRunner` takes a `userId`, so the screen needs the outlet's
 * runnable staff as typed data instead of a free-typed id (bead legend-zvz).
 * Which roles may run is roster/configuration, decided by the API.
 */
export const expoRunnerSchema = z.strictObject({
  ...outletScope,
  userId: userIdSchema,
  name,
});
export type ExpoRunner = z.infer<typeof expoRunnerSchema>;

/* ---------------------------------------------------------- pickup display */

/**
 * F12 "Pickup Display": takeaway and delivery call numbers (§6 `orders.channel`).
 * `delivery` is the outlet's own POS delivery (service type, not a platform).
 */
export const pickupChannelSchema = z.enum([
  "takeaway",
  "delivery",
  "gofood",
  "grabfood",
  "shopeefood",
]);
export const pickupCallStatusSchema = z.enum([
  "assigned",
  "called",
  "picked_up",
]);

export const pickupCallSchema = z
  .strictObject({
    ...outletScope,
    id: uuidSchema,
    orderId: orderIdSchema,
    channel: pickupChannelSchema,
    /**
     * Daily per-outlet sequence (1, 2, 3...). No upper bound: orders are never
     * refused when the numbers run out (legend-ggpoe).
     */
    number: z.number().int().positive(),
    /** Code shown on the pickup display and receipt: A-001..A-999, B-001... */
    code: z.string().regex(PICKUP_CODE_PATTERN),
    businessDate: businessDateSchema,
    status: pickupCallStatusSchema,
    calledAt: isoDateTimeSchema.nullable(),
    pickedUpAt: isoDateTimeSchema.nullable(),
  })
  .refine((call) => call.status === "assigned" || call.calledAt !== null, {
    path: ["calledAt"],
    message: "A called number records calledAt",
  })
  .refine((call) => call.status !== "picked_up" || call.pickedUpAt !== null, {
    path: ["pickedUpAt"],
    message: "A picked-up number records pickedUpAt",
  });

/** "Panggil" (assigned/called -> called) and "Diambil" (called -> picked_up). */
export const pickupCallActionSchema = z.enum(["call", "pickup"]);
export type PickupCallAction = z.infer<typeof pickupCallActionSchema>;

/**
 * One explicit transition table for FE and BE (bead legend-usw3). A listed
 * transition to the same status is a repeat: the call succeeds and changes
 * nothing. `call` on `called` re-announces the number and keeps the first
 * `calledAt`; `pickup` on `picked_up` keeps the first `pickedUpAt`. Anything
 * not listed fails: `pickup` from `assigned` (PICKUP_CALL_NOT_CALLED) and
 * `call` from `picked_up` (PICKUP_CALL_CLOSED), see `pickupCallBlock`;
 * picked_up is terminal.
 */
export const PICKUP_CALL_TRANSITIONS: Record<
  PickupCallStatus,
  Partial<Record<PickupCallAction, PickupCallStatus>>
> = {
  assigned: { call: "called" },
  called: { call: "called", pickup: "picked_up" },
  picked_up: { pickup: "picked_up" },
};

export function canTransitionPickupCall(
  status: PickupCallStatus,
  action: PickupCallAction,
): boolean {
  return PICKUP_CALL_TRANSITIONS[status][action] !== undefined;
}

/** True when the action leaves the status as it is (idempotent repeat). */
export function isPickupCallRepeat(
  status: PickupCallStatus,
  action: PickupCallAction,
): boolean {
  return PICKUP_CALL_TRANSITIONS[status][action] === status;
}

/** Error code an invalid pickup action fails with; null = allowed (or a repeat). */
export function pickupCallBlock(
  status: PickupCallStatus,
  action: PickupCallAction,
): "PICKUP_CALL_NOT_CALLED" | "PICKUP_CALL_CLOSED" | null {
  if (canTransitionPickupCall(status, action)) return null;
  return action === "pickup" ? "PICKUP_CALL_NOT_CALLED" : "PICKUP_CALL_CLOSED";
}

export function transitionPickupCall(
  status: PickupCallStatus,
  action: PickupCallAction,
): PickupCallStatus {
  const next = PICKUP_CALL_TRANSITIONS[status][action];
  if (next === undefined)
    throw new RangeError(`Pickup call cannot ${action} from ${status}`);
  return next;
}

/**
 * F12 "Pickup Display ... dengan promosi": the promotion slide a wall display
 * shows between call numbers. Display-safe by design — no codes, quotas or
 * budget (those stay in the promo engine, @starter/shared/crm) — so the feed
 * cannot leak campaign internals to a customer-facing screen (bead legend-zvz).
 */
export const pickupPromotionSchema = z.strictObject({
  ...outletScope,
  id: uuidSchema,
  title: name,
  body: z.string().min(1).max(280),
  /** Null = runs until the campaign ends; the display then keeps showing it. */
  validUntil: isoDateTimeSchema.nullable(),
});
export type PickupPromotion = z.infer<typeof pickupPromotionSchema>;

export const pickupDisplaySchema = z.strictObject({
  ...outletScope,
  generatedAt: isoDateTimeSchema,
  calls: z.array(pickupCallSchema),
  promotions: z.array(pickupPromotionSchema),
});

/* -------------------------------------------------------- serving time */

/**
 * F12 "Estimasi Waktu Saji Real-time", shown on QR order and POS before
 * checkout (PRD §3 F11 "Estimasi Waktu Saji"). `queueLoadPoints` and
 * `queueItems` are the actual per-station queue the server read; KDS-06
 * (median estimate within 3 minutes) is a load-test property of that
 * computation, not of this shape.
 */
export const servingTimeEstimateSchema = z.strictObject({
  ...outletScope,
  channel: channelSchema,
  queueItems: z.number().int().nonnegative(),
  queueLoadPoints: z.number().int().nonnegative(),
  estimatedMinutes: z.number().int().nonnegative().max(720),
  estimatedReadyAt: isoDateTimeSchema,
  computedAt: isoDateTimeSchema,
});

/** One finished ticket: the per item/station/hour/employee row F12 asks for. */
export const servingTimeSampleSchema = z
  .strictObject({
    ...outletScope,
    ticketId: kitchenTicketIdSchema,
    stationId: stationIdSchema,
    orderId: orderIdSchema,
    employeeId: userIdSchema.nullable(),
    startedAt: isoDateTimeSchema,
    doneAt: isoDateTimeSchema.nullable(),
    seconds: z.number().int().nonnegative().max(86_400).nullable(),
    targetSeconds: z.number().int().positive().max(86_400).nullable(),
    metTarget: z.boolean().nullable(),
  })
  .refine((sample) => (sample.doneAt === null) === (sample.seconds === null), {
    path: ["seconds"],
    message: "An unfinished sample has no duration",
  })
  .refine(
    (sample) => (sample.seconds === null) === (sample.metTarget === null),
    { path: ["metTarget"], message: "A duration has a target verdict" },
  );

export const servingTimeGroupSchema = z.enum([
  "station",
  "hour",
  "employee",
  "item",
]);

export const servingTimeSummarySchema = z.strictObject({
  ...outletScope,
  group: servingTimeGroupSchema,
  /** Stable group key: station id, `09` hour, employee id or menu item id. */
  groupKey: z.string().min(1).max(100),
  label: name,
  sampleCount: z.number().int().positive(),
  medianSeconds: z.number().int().nonnegative().max(86_400),
  averageSeconds: z.number().int().nonnegative().max(86_400),
  targetSeconds: z.number().int().positive().max(86_400).nullable(),
  withinTargetBp: basisPointsSchema,
});

/* ------------------------------------------------------------ remake / comp */

/** PRD §6 `order_issues.type` and F41 "Remake & Comp". */
export const orderIssueTypeSchema = z.enum([
  "unfulfillable",
  "remake",
  "comp",
  "complaint",
]);
/** F41 standard reasons: salah pesanan, kualitas, terlambat, keluhan, bahan habis. */
export const orderIssueReasonSchema = z.enum([
  "wrong_order",
  "quality",
  "late",
  "complaint",
  "out_of_stock",
  "other",
]);
/** PRD §6 `order_issues.resolution`. */
export const orderIssueResolutionSchema = z.enum([
  "swap",
  "voucher",
  "manual_refund",
]);
/** Lifecycle of one issue: guest/staff resolution moves `open` to `resolved`. */
export const ORDER_ISSUE_STATUSES = ["open", "resolved", "cancelled"] as const;
export const orderIssueStatusSchema = z.enum(ORDER_ISSUE_STATUSES);

/**
 * Cross-field rules shared by the stored record and the staff input, so the
 * KDS form, the QR recovery flow and the table agree (legend-d60m).
 */
type OrderIssueRuleFields = {
  type: z.infer<typeof orderIssueTypeSchema>;
  resolution: z.infer<typeof orderIssueResolutionSchema> | null;
  voucherId: string | null;
  replacementItemId: string | null;
  approvedBy: string | null;
  employeeId: string | null;
  reasonNote: string;
};
const orderIssueRules = (
  issue: OrderIssueRuleFields,
  ctx: z.RefinementCtx,
): void => {
  const add = (path: string, message: string, invalid: boolean) => {
    if (invalid) ctx.addIssue({ code: "custom", path: [path], message });
  };
  add(
    "approvedBy",
    "A manual refund requires supervisor approval (R25, ORD-09)",
    issue.resolution === "manual_refund" && issue.approvedBy === null,
  );
  add(
    "reasonNote",
    "A manual refund needs a written reason of at least 10 characters (R25, ORD-09)",
    issue.resolution === "manual_refund" && issue.reasonNote.trim().length < 10,
  );
  add(
    "voucherId",
    "A voucher resolution records the voucher",
    issue.resolution === "voucher" && issue.voucherId === null,
  );
  add(
    "replacementItemId",
    "A swap needs the replacement menu item",
    issue.resolution === "swap" && issue.replacementItemId === null,
  );
  add(
    "employeeId",
    "A remake or comp records the staff member (KDS-07)",
    (issue.type === "remake" || issue.type === "comp") &&
      issue.employeeId === null,
  );
};

/**
 * THE `order_issues` record (PRD §6 C, F41, KDS-07, R25, ORD-08/09). One shape
 * for the KDS remake/comp log and the QR recovery flow (legend-d60m):
 * - `reason` is the standard enum, `reasonNote` the written reason (the QR
 *   free-text reason lives there);
 * - `stationId`/`employeeId` are KDS-07 attribution, null for an issue no
 *   station produced (a stock-out found at the pass);
 * - `status`/`resolvedAt`/`replacementItemId`/`priceDifferenceIdr` are the QR
 *   recovery lifecycle; a staff-recorded remake or comp is born `resolved`.
 * `costIdr` is whole rupiah (D-CORE-2) computed server-side from the recipe.
 */
const orderIssueFields = {
  ...outletScope,
  id: uuidSchema,
  orderId: orderIdSchema,
  orderItemId: orderItemIdSchema,
  type: orderIssueTypeSchema,
  reason: orderIssueReasonSchema,
  /** Written reason, mandatory for R25 ("alasan tertulis"). */
  reasonNote: z.string().min(1).max(500),
  stationId: stationIdSchema.nullable(),
  /** Staff member whose station produced the remake/comp (KDS-07). */
  employeeId: userIdSchema.nullable(),
  reportedBy: userIdSchema,
  resolution: orderIssueResolutionSchema.nullable(),
  replacementItemId: uuidSchema.nullable(),
  voucherId: uuidSchema.nullable(),
  /** Positive: the guest pays the difference; negative: the guest is credited. */
  priceDifferenceIdr: idrSchema.nullable(),
  approvedBy: userIdSchema.nullable(),
  /** Ingredient cost of the remake/comp, whole rupiah (KDS-07). */
  costIdr: idrSchema.refine((amount) => amount >= 0, {
    message: "Ingredient cost cannot be negative",
  }),
  status: orderIssueStatusSchema,
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
};

/** Lifecycle rules of the stored record, shared with the read projection. */
type OrderIssueStateFields = OrderIssueRuleFields & {
  status: z.infer<typeof orderIssueStatusSchema>;
  resolvedAt: string | null;
};
const orderIssueStateRules = (
  issue: OrderIssueStateFields,
  ctx: z.RefinementCtx,
): void => {
  orderIssueRules(issue, ctx);
  const add = (path: string, message: string, invalid: boolean) => {
    if (invalid) ctx.addIssue({ code: "custom", path: [path], message });
  };
  add(
    "resolution",
    "An open issue has no resolution yet",
    issue.status === "open" && issue.resolution !== null,
  );
  add(
    "resolvedAt",
    "A resolved issue needs a resolution and resolvedAt",
    issue.status === "resolved" &&
      (issue.resolution === null || issue.resolvedAt === null),
  );
  add(
    "resolvedAt",
    "A cancelled issue is not resolved",
    issue.status === "cancelled" && issue.resolvedAt !== null,
  );
};

export const orderIssueSchema = z
  .strictObject(orderIssueFields)
  .superRefine(orderIssueStateRules);

/**
 * `listOrderIssues` row (legend-0eq7): the record plus the readable labels the
 * log shows, so the UI never renders an id. `orderLabel` is the order number
 * (`orders.number`), `itemName` the name snapshotted on the order line, and
 * the staff names come from the user table; each is null only when the
 * matching id is null.
 */
export const orderIssueViewSchema = z
  .strictObject({
    ...orderIssueFields,
    orderLabel: z.string().min(1).max(30),
    itemName: name,
    reportedByName: z.string().min(1).max(100),
    employeeName: z.string().min(1).max(100).nullable(),
    approvedByName: z.string().min(1).max(100).nullable(),
  })
  .superRefine(orderIssueStateRules)
  .superRefine((issue, ctx) => {
    for (const [id, label, path] of [
      [issue.employeeId, issue.employeeName, "employeeName"],
      [issue.approvedBy, issue.approvedByName, "approvedByName"],
    ] as const)
      if ((id === null) !== (label === null))
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: "A staff name is present exactly when its id is",
        });
  });

/**
 * What the POS/KDS submits. `costIdr` is NOT client input: the API computes
 * the ingredient cost from the recipe/BOM at the time of the issue (KDS-07
 * "biaya bahan"), so a client cannot under-report it. The same cross-field
 * rules as the stored record apply, so the FE form fails before the request.
 * `approvedBy` names the supervisor who approved a manual refund (R25); the
 * field alone is never proof of approval, so `reportOrderIssue` refuses
 * `manual_refund` until a real approval flow exists (422).
 */
export const createOrderIssueInputSchema = z
  .strictObject({
    orderItemId: orderItemIdSchema,
    type: orderIssueTypeSchema,
    reason: orderIssueReasonSchema,
    reasonNote: z.string().min(1).max(500),
    stationId: stationIdSchema.nullable(),
    employeeId: userIdSchema.nullable(),
    resolution: orderIssueResolutionSchema.nullable(),
    replacementItemId: uuidSchema.nullable().default(null),
    voucherId: uuidSchema.nullable(),
    approvedBy: userIdSchema.nullable(),
    /** A resend of the same key returns the stored issue, never a second one. */
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(orderIssueRules);

/* ------------------------------------------------------------- KDS board */

/** One station tab of the KDS: tickets, batch counts and current pacing. */
export const stationBoardSchema = z.strictObject({
  ...outletScope,
  stationId: stationIdSchema,
  generatedAt: isoDateTimeSchema,
  tickets: z.array(kitchenTicketDetailSchema),
  allDay: allDayCountSchema,
  pacing: stationPacingSchema,
});

/**
 * legend-tsp5: the light poll behind the KDS station switch. One row per
 * station the caller may see; `openTickets` counts new, in progress and
 * recalled tickets (done and cancelled do not count).
 */
export const stationSummarySchema = z
  .strictObject({
    ...outletScope,
    generatedAt: isoDateTimeSchema,
    stations: z.array(
      z.strictObject({
        stationId: stationIdSchema,
        openTickets: z.number().int().nonnegative(),
      }),
    ),
  })
  .refine(
    (summary) =>
      new Set(summary.stations.map((row) => row.stationId)).size ===
      summary.stations.length,
    { path: ["stations"], message: "A station appears once in the summary" },
  );

/* ------------------------------------------------------------- fixture set */

/** Whole Cafe Legend kitchen fixture; must parse as one object (test). */
export const kitchenFixtureSchema = z.strictObject({
  stationConfigs: z.array(stationConfigSchema),
  menuLoads: z.array(menuLoadSchema),
  capacityRules: z.array(capacityRuleSchema),
  tickets: z.array(kitchenTicketSchema),
  ticketItems: z.array(kitchenTicketItemSchema),
  ticketStatusChanges: z.array(ticketStatusChangeSchema),
  pacing: pacingSnapshotSchema,
  allDay: allDayCountSchema,
  expo: expoBoardSchema,
  expoRunners: z.array(expoRunnerSchema),
  pickupDisplay: pickupDisplaySchema,
  servingTimeEstimate: servingTimeEstimateSchema,
  servingTimeSamples: z.array(servingTimeSampleSchema),
  servingTimeSummaries: z.array(servingTimeSummarySchema),
  orderIssues: z.array(orderIssueSchema),
  channelPauses: z.array(channelPauseSchema),
  stationBoards: z.array(stationBoardSchema),
  stationSummary: stationSummarySchema,
});

export type StationSummary = z.infer<typeof stationSummarySchema>;
export type StationConfig = z.infer<typeof stationConfigSchema>;
export type StationLabel = z.infer<typeof stationLabelSchema>;
export type StationCapacityRule = z.infer<typeof stationCapacityRuleSchema>;
export type MenuLoad = z.infer<typeof menuLoadSchema>;
export type CapacitySchedule = z.infer<typeof capacityScheduleSchema>;
export type CapacityRule = z.infer<typeof capacityRuleSchema>;
export type CapacityRuleInput = z.infer<typeof capacityRuleInputSchema>;
export type StationPacing = z.infer<typeof stationPacingSchema>;
export type PacingSnapshot = z.infer<typeof pacingSnapshotSchema>;
export type ChannelPause = z.infer<typeof channelPauseSchema>;
export type MenuLoadInput = z.infer<typeof menuLoadInputSchema>;
export type ManualChannelPauseInput = z.infer<
  typeof manualChannelPauseInputSchema
>;
export type AllDayCountRow = z.infer<typeof allDayCountRowSchema>;
export type AllDayCount = z.infer<typeof allDayCountSchema>;
export type ExpoStationTicket = z.infer<typeof expoStationTicketSchema>;
export type ExpoTicket = z.infer<typeof expoTicketSchema>;
export type ExpoBoard = z.infer<typeof expoBoardSchema>;
export type PickupChannel = z.infer<typeof pickupChannelSchema>;
export type PickupCallStatus = z.infer<typeof pickupCallStatusSchema>;
export type PickupCall = z.infer<typeof pickupCallSchema>;
export type PickupDisplay = z.infer<typeof pickupDisplaySchema>;
export type ServingTimeEstimate = z.infer<typeof servingTimeEstimateSchema>;
export type ServingTimeSample = z.infer<typeof servingTimeSampleSchema>;
export type ServingTimeGroup = z.infer<typeof servingTimeGroupSchema>;
export type ServingTimeSummary = z.infer<typeof servingTimeSummarySchema>;
export type OrderIssueType = z.infer<typeof orderIssueTypeSchema>;
export type OrderIssueReason = z.infer<typeof orderIssueReasonSchema>;
export type OrderIssueStatus = z.infer<typeof orderIssueStatusSchema>;
export type OrderIssueResolution = z.infer<typeof orderIssueResolutionSchema>;
export type OrderIssue = z.infer<typeof orderIssueSchema>;
export type OrderIssueView = z.infer<typeof orderIssueViewSchema>;
export type CreateOrderIssueInput = z.infer<typeof createOrderIssueInputSchema>;
export type KitchenTicket = z.infer<typeof kitchenTicketSchema>;
export type KitchenTicketDetail = z.infer<typeof kitchenTicketDetailSchema>;
export type KitchenTicketItem = z.infer<typeof kitchenTicketItemSchema>;
export type TicketStatusChange = z.infer<typeof ticketStatusChangeSchema>;
export type StationBoard = z.infer<typeof stationBoardSchema>;
export type KitchenFixture = z.infer<typeof kitchenFixtureSchema>;
