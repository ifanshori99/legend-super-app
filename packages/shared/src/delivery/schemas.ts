// Delivery channel (ojek online) contract: the platform order record of PRD
// v1.7 §6.G `delivery_channel_orders`, the external→internal menu mapping,
// fulfilment status and the commission reconciliation of §3.23 "Integrasi Ojek
// Online" (features F20, D12). The `DeliveryChannel` adapter interface itself
// lives in `@starter/shared/adapters` (WS-00); this module is the order data
// the adapter and the POS exchange.
//
// Platform facts: GoFood, GrabFood and ShopeeFood arrive through adapters with
// a channel tag; until a partner approves the integration the cashier records
// the same order in the POS (D12 "Mode Manual"), which is why every order
// carries `source`. `externalOrderId` is unique per platform (PRD §6.G).
//
// Money: `gross_idr` and `commission_idr` come from the platform statement or
// payload, not from our price list, so they are recorded as reported (still
// whole rupiah, BIGINT). `net = gross − commission` is always derived by
// `deliveryNetIdr`, never stored twice. Our channel prices (price lists per
// channel, WS-03) are `channelPriceIdr` on a mapped line: a platform price that
// differs is a `price_mismatch` for staff to review, not silently accepted.

import {
  z,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  uuidIdSchema,
  idrSchema,
  isoDateTimeSchema,
  businessDateSchema,
  clientInputSchema,
  sumIdr,
} from "../core/index.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import { channelSchema } from "../menu/schemas.ts";

const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const reference = z.string().min(1).max(100);
const note300 = z.string().max(300);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };

// ---- Ids and platforms ----------------------------------------------------

export const deliveryChannelOrderIdSchema =
  uuidIdSchema<"DeliveryChannelOrderId">();
export const deliverySettlementLineIdSchema =
  uuidIdSchema<"DeliverySettlementLineId">();

/**
 * The three delivery platforms of PRD F20. Extracted from the menu channel
 * enum so a price list channel and a delivery order channel cannot drift.
 */
export const deliveryPlatformSchema = channelSchema.extract([
  "gofood",
  "grabfood",
  "shopeefood",
]);
export type DeliveryPlatform = z.infer<typeof deliveryPlatformSchema>;
export const DELIVERY_PLATFORMS = deliveryPlatformSchema.options;

// ---- Orders (§6.G delivery_channel_orders, §3.23) -------------------------

export const DELIVERY_ORDER_STATUSES = [
  "received",
  "accepted",
  "preparing",
  "ready",
  "picked_up",
  "delivered",
  "cancelled",
  "rejected",
] as const;
export const deliveryOrderStatusSchema = z.enum(DELIVERY_ORDER_STATUSES);
export type DeliveryOrderStatus = z.infer<typeof deliveryOrderStatusSchema>;

/** `platform`: the adapter received it. `manual_pos`: cashier recorded it (D12). */
export const deliveryOrderSourceSchema = z.enum(["platform", "manual_pos"]);

/**
 * Platform sync of an order's latest staff step (legend-r7vxn): `ok` nothing
 * pending, `retrying` the system resends it, `needs_action` the platform
 * refused it or retries ran out, so staff must act (staff screens flag it).
 */
export const deliveryPlatformSyncSchema = z.enum([
  "ok",
  "retrying",
  "needs_action",
]);
export type DeliveryPlatformSync = z.infer<typeof deliveryPlatformSyncSchema>;
export type DeliveryOrderSource = z.infer<typeof deliveryOrderSourceSchema>;

export const DELIVERY_MAPPING_STATUSES = [
  "matched",
  "price_mismatch",
  "unmatched",
  "sold_out",
] as const;
export const deliveryMappingStatusSchema = z.enum(DELIVERY_MAPPING_STATUSES);
export type DeliveryMappingStatus = z.infer<typeof deliveryMappingStatusSchema>;

export const deliveryLineModifierSchema = z.strictObject({
  name: z.string().min(1).max(100),
  priceIdr: nonnegativeIdr,
});
export type DeliveryLineModifier = z.infer<typeof deliveryLineModifierSchema>;

/** One platform line mapped onto our menu (PRD §3.23 "Injeksi Pesanan"). */
export const deliveryOrderLineSchema = z
  .strictObject({
    /** Platform line number, stable within the order. */
    lineNo: z.number().int().min(1).max(200),
    externalItemId: reference.nullable(),
    externalItemName: z.string().min(1).max(200),
    /** Null only when the line has no menu match (`unmatched`). */
    menuItemId: uuidSchema.nullable(),
    variantId: uuidSchema.nullable(),
    quantity: z.number().int().min(1).max(99),
    /** Price the platform charges; whole rupiah, as reported. */
    unitPriceIdr: nonnegativeIdr,
    lineTotalIdr: nonnegativeIdr,
    modifiers: z.array(deliveryLineModifierSchema).max(20),
    note: z.string().max(200).nullable(),
    mapping: deliveryMappingStatusSchema,
    /** Our channel price list price for the matched item; null when unmatched. */
    channelPriceIdr: nonnegativeIdr.nullable(),
  })
  .superRefine((line, ctx) => {
    if (line.mapping === "unmatched" && line.menuItemId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["menuItemId"],
        message: "An unmatched line has no menu item",
      });
    if (line.mapping !== "unmatched" && line.menuItemId === null)
      ctx.addIssue({
        code: "custom",
        path: ["menuItemId"],
        message: "A mapped line names its menu item",
      });
    if (line.mapping === "unmatched" && line.channelPriceIdr !== null)
      ctx.addIssue({
        code: "custom",
        path: ["channelPriceIdr"],
        message: "An unmatched line has no channel price",
      });
    if (
      line.mapping === "matched" &&
      line.channelPriceIdr !== line.unitPriceIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["mapping"],
        message: "A matched line agrees with the channel price",
      });
    if (
      line.mapping === "price_mismatch" &&
      line.channelPriceIdr === line.unitPriceIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["mapping"],
        message: "A price mismatch differs from the channel price",
      });
  });
export type DeliveryOrderLine = z.infer<typeof deliveryOrderLineSchema>;

export const deliveryChannelOrderSchema = z
  .strictObject({
    id: deliveryChannelOrderIdSchema,
    ...scope,
    platform: deliveryPlatformSchema,
    /** Unique per platform (PRD §6.G). */
    externalOrderId: reference,
    /** Internal order injected to the KDS; null until accepted/injected. */
    orderId: orderIdSchema.nullable(),
    /** Internal order/pickup number for the pickup display; null until injected. */
    number: z.string().min(1).max(30).nullable(),
    status: deliveryOrderStatusSchema,
    source: deliveryOrderSourceSchema,
    /** Reported by the platform; may still be 0 until settlement. */
    grossIdr: nonnegativeIdr,
    commissionIdr: nonnegativeIdr,
    /** SHA-256 of the raw platform payload (dedupe and audit); manual rows hash the typed input. */
    payloadHash: sha256HexSchema,
    customerNote: note300.nullable(),
    lines: z.array(deliveryOrderLineSchema).min(1),
    receivedAt: isoDateTimeSchema,
    acceptedAt: isoDateTimeSchema.nullable(),
    readyAt: isoDateTimeSchema.nullable(),
    pickedUpAt: isoDateTimeSchema.nullable(),
    deliveredAt: isoDateTimeSchema.nullable(),
    /** Cancelled or rejected instant. */
    closedAt: isoDateTimeSchema.nullable(),
    closeReason: note300.nullable(),
    /** Commission settlement: when the platform statement matched this order. */
    settledAt: isoDateTimeSchema.nullable(),
    settledNetIdr: nonnegativeIdr.nullable(),
    /** Platform sync of the latest status step; manual orders stay `ok`. */
    platformSync: deliveryPlatformSyncSchema.default("ok"),
  })
  .superRefine((order, ctx) => {
    if (
      new Set(order.lines.map((line) => line.lineNo)).size !==
      order.lines.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "Line numbers are unique within an order",
      });
    if (order.commissionIdr > order.grossIdr)
      ctx.addIssue({
        code: "custom",
        path: ["commissionIdr"],
        message: "Commission cannot exceed gross revenue",
      });
    if (
      ["accepted", "preparing", "ready", "picked_up", "delivered"].includes(
        order.status,
      ) &&
      order.acceptedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["acceptedAt"],
        message: "An accepted order records when it was accepted",
      });
    if (
      ["picked_up", "delivered"].includes(order.status) &&
      order.pickedUpAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["pickedUpAt"],
        message: "A picked-up order records the handover",
      });
    if (order.status === "delivered" && order.deliveredAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["deliveredAt"],
        message: "A delivered order records when it completed",
      });
    const closed = order.status === "cancelled" || order.status === "rejected";
    if (closed && order.closedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "A cancelled or rejected order records when it closed",
      });
    if (!closed && order.closedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "Only a cancelled or rejected order has a close instant",
      });
    // An order reaches the KDS only when every line maps to a menu item
    // (`assertDeliveryOrderInjectable`); an unmatched line keeps it out.
    if (
      order.orderId !== null &&
      order.lines.some((line) => line.mapping === "unmatched")
    )
      ctx.addIssue({
        code: "custom",
        path: ["orderId"],
        message: "An order with an unmatched line is not injected to the KDS",
      });
    if ((order.settledAt === null) !== (order.settledNetIdr === null))
      ctx.addIssue({
        code: "custom",
        path: ["settledAt"],
        message: "A settlement instant and its amount always appear together",
      });
  });
export type DeliveryChannelOrder = z.infer<typeof deliveryChannelOrderSchema>;

// ---- Channel state per platform (§3.23 "Adapter per Platform") ------------

export const DELIVERY_SYNC_STATUSES = ["ok", "stale", "error"] as const;
export const deliverySyncStatusSchema = z.enum(DELIVERY_SYNC_STATUSES);
export type DeliverySyncStatus = z.infer<typeof deliverySyncStatusSchema>;

/** Store open/close and menu sync status for one platform. */
export const deliveryChannelSchema = z
  .strictObject({
    ...scope,
    platform: deliveryPlatformSchema,
    /** Store open on the platform (orders may arrive). */
    isOpen: z.boolean(),
    /** Reopen automatically at this instant; null = manual reopen. */
    closedUntil: isoDateTimeSchema.nullable(),
    closedReason: z.string().max(200).nullable(),
    syncStatus: deliverySyncStatusSchema,
    lastSyncedAt: isoDateTimeSchema.nullable(),
    syncError: z.string().max(300).nullable(),
    /** Menu items currently published on the platform. */
    menuItemCount: z.number().int().min(0),
    soldOutItemCount: z.number().int().min(0),
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((channel, ctx) => {
    if (channel.syncStatus === "error" && channel.syncError === null)
      ctx.addIssue({
        code: "custom",
        path: ["syncError"],
        message: "An error sync states its error",
      });
    if (channel.syncStatus !== "error" && channel.syncError !== null)
      ctx.addIssue({
        code: "custom",
        path: ["syncError"],
        message: "Only a failed sync carries an error message",
      });
    if (channel.syncStatus === "ok" && channel.lastSyncedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["lastSyncedAt"],
        message: "A successful sync records when it ran",
      });
    if (channel.isOpen && channel.closedUntil !== null)
      ctx.addIssue({
        code: "custom",
        path: ["closedUntil"],
        message: "An open store has no reopen instant",
      });
  });
export type DeliveryChannel = z.infer<typeof deliveryChannelSchema>;

/** A menu sync run result (after the adapter pushed the price list). */
export const deliveryMenuSyncResultSchema = z.strictObject({
  channel: deliveryChannelSchema,
  pushedItemCount: z.number().int().min(0),
  soldOutItemCount: z.number().int().min(0),
});
export type DeliveryMenuSyncResult = z.infer<
  typeof deliveryMenuSyncResultSchema
>;

// ---- Requests -------------------------------------------------------------

export const setDeliveryChannelStateInputSchema = clientInputSchema({
  isOpen: z.boolean(),
  closedUntil: isoDateTimeSchema.nullable().optional(),
  closedReason: z.string().max(200).nullable().optional(),
});
export type SetDeliveryChannelStateInput = z.infer<
  typeof setDeliveryChannelStateInputSchema
>;

/**
 * Create or link the channel of one outlet and platform (legend-cbd0): the
 * platform's merchant/store id. The channel is born closed and stale.
 */
export const linkDeliveryChannelInputSchema = clientInputSchema({
  storeExternalId: z.string().trim().min(1).max(100),
});
export type LinkDeliveryChannelInput = z.infer<
  typeof linkDeliveryChannelInputSchema
>;

export const listDeliveryOrdersQuerySchema = z.strictObject({
  platform: deliveryPlatformSchema.optional(),
  status: deliveryOrderStatusSchema.optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListDeliveryOrdersQuery = z.infer<
  typeof listDeliveryOrdersQuerySchema
>;

/**
 * D12 "Mode Manual": the cashier records the platform order in the POS with
 * its channel and the channel price. The server resolves prices from the
 * platform price list; the client never sends money.
 */
export const createManualDeliveryOrderInputSchema = clientInputSchema({
  platform: deliveryPlatformSchema,
  externalOrderId: reference,
  lines: z
    .array(
      z.strictObject({
        menuItemId: uuidSchema,
        variantId: uuidSchema.nullable().optional(),
        quantity: z.number().int().min(1).max(99),
        note: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
  customerNote: note300.nullable().optional(),
});
export type CreateManualDeliveryOrderInput = z.infer<
  typeof createManualDeliveryOrderInputSchema
>;

/** Move the order along the fulfilment machine and push it to the platform. */
export const updateDeliveryOrderStatusInputSchema = clientInputSchema({
  status: deliveryOrderStatusSchema,
  /** Required for `cancelled` and `rejected`. */
  reason: note300.optional(),
}).refine(
  (input) =>
    (input.status !== "cancelled" && input.status !== "rejected") ||
    (input.reason !== undefined && input.reason.trim().length > 0),
  {
    path: ["reason"],
    message: "Cancelling or rejecting an order names a reason",
  },
);
export type UpdateDeliveryOrderStatusInput = z.infer<
  typeof updateDeliveryOrderStatusInputSchema
>;

/**
 * Staff resend of the held platform step of a `needs_action` order
 * (legend-eyqvo): no input, the stored step is the one resent.
 */
export const resendDeliveryOrderSyncInputSchema = clientInputSchema({});
export type ResendDeliveryOrderSyncInput = z.infer<
  typeof resendDeliveryOrderSyncInputSchema
>;

/** Staff marks a `needs_action` order as handled in the partner app. */
export const resolveDeliveryOrderSyncInputSchema = clientInputSchema({
  reason: note300.optional(),
});
export type ResolveDeliveryOrderSyncInput = z.infer<
  typeof resolveDeliveryOrderSyncInputSchema
>;

/**
 * Staff map the unmatched or sold_out lines of a needs_review order (webhook
 * lines that did not match the menu or whose item sold out) to menu items and
 * inject it into the KDS (legend-5d76). Only unmatched or sold_out lines are
 * mapped; the order total stays the platform's (lines keep the platform
 * price), so the mapping never changes what the platform pays.
 */
export const mapDeliveryOrderLinesInputSchema = clientInputSchema({
  mappings: z
    .array(
      z.strictObject({
        lineNo: z.number().int().min(1).max(200),
        menuItemId: uuidSchema,
        variantId: uuidSchema.nullable().optional(),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (rows) => new Set(rows.map((row) => row.lineNo)).size === rows.length,
      { message: "A line is mapped once" },
    ),
});
export type MapDeliveryOrderLinesInput = z.infer<
  typeof mapDeliveryOrderLinesInputSchema
>;

// ---- Commission reconciliation (§3.23 "Rekonsiliasi Komisi") --------------

export const DELIVERY_SETTLEMENT_STATUSES = [
  "matched",
  "variance",
  "unknown_order",
] as const;
export const deliverySettlementStatusSchema = z.enum(
  DELIVERY_SETTLEMENT_STATUSES,
);
export type DeliverySettlementStatus = z.infer<
  typeof deliverySettlementStatusSchema
>;

/** One platform statement line (settlement) for an external order id. */
export const deliverySettlementLineSchema = z
  .strictObject({
    id: deliverySettlementLineIdSchema,
    ...scope,
    platform: deliveryPlatformSchema,
    externalOrderId: reference,
    grossIdr: nonnegativeIdr,
    commissionIdr: nonnegativeIdr,
    /** Money actually received from the platform for this order. */
    settledNetIdr: nonnegativeIdr,
    /** Internal delivery order this line was matched to; null = unknown_order. */
    deliveryChannelOrderId: deliveryChannelOrderIdSchema.nullable(),
    status: deliverySettlementStatusSchema,
    /** Signed difference between reported net and settled net (0 when matched). */
    varianceIdr: idrSchema,
    settledOn: businessDateSchema,
  })
  .superRefine((line, ctx) => {
    if (line.commissionIdr > line.grossIdr)
      ctx.addIssue({
        code: "custom",
        path: ["commissionIdr"],
        message: "Commission cannot exceed gross revenue",
      });
    if (line.status === "unknown_order" && line.deliveryChannelOrderId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["deliveryChannelOrderId"],
        message: "An unknown order has no internal delivery order",
      });
    if (line.status !== "unknown_order" && line.deliveryChannelOrderId === null)
      ctx.addIssue({
        code: "custom",
        path: ["deliveryChannelOrderId"],
        message: "A matched line names the internal delivery order",
      });
    if (line.status === "matched" && line.varianceIdr !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["varianceIdr"],
        message: "A matched line has no variance",
      });
    if (line.status === "variance" && line.varianceIdr === 0)
      ctx.addIssue({
        code: "custom",
        path: ["varianceIdr"],
        message: "A variance line differs from the internal amount",
      });
  });
export type DeliverySettlementLine = z.infer<
  typeof deliverySettlementLineSchema
>;

export const deliveryReconciliationSummarySchema = z.strictObject({
  lineCount: z.number().int().min(0),
  matchedCount: z.number().int().min(0),
  varianceCount: z.number().int().min(0),
  unknownOrderCount: z.number().int().min(0),
  grossIdr: nonnegativeIdr,
  commissionIdr: nonnegativeIdr,
  settledNetIdr: nonnegativeIdr,
  /** Signed total of the line variances; 0 when everything matched. */
  varianceIdr: idrSchema,
});
export type DeliveryReconciliationSummary = z.infer<
  typeof deliveryReconciliationSummarySchema
>;

export const deliveryReconciliationSchema = z.strictObject({
  ...scope,
  platform: deliveryPlatformSchema,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  lines: z.array(deliverySettlementLineSchema),
  summary: deliveryReconciliationSummarySchema,
});
export type DeliveryReconciliation = z.infer<
  typeof deliveryReconciliationSchema
>;

export const deliveryReconciliationQuerySchema = z
  .strictObject({
    platform: deliveryPlatformSchema,
    periodStart: businessDateSchema,
    periodEnd: businessDateSchema,
  })
  .refine(
    (query) =>
      Date.parse(`${query.periodEnd}T00:00:00Z`) >=
      Date.parse(`${query.periodStart}T00:00:00Z`),
    { path: ["periodEnd"], message: "periodEnd must not precede periodStart" },
  );
export type DeliveryReconciliationQuery = z.infer<
  typeof deliveryReconciliationQuerySchema
>;

/** Summary totals derived from the lines; the service returns this shape. */
export function deliveryReconciliationSummaryOf(
  lines: readonly DeliverySettlementLine[],
): DeliveryReconciliationSummary {
  return deliveryReconciliationSummarySchema.parse({
    lineCount: lines.length,
    matchedCount: lines.filter((line) => line.status === "matched").length,
    varianceCount: lines.filter((line) => line.status === "variance").length,
    unknownOrderCount: lines.filter((line) => line.status === "unknown_order")
      .length,
    grossIdr: sumIdr(lines.map((line) => line.grossIdr)),
    commissionIdr: sumIdr(lines.map((line) => line.commissionIdr)),
    settledNetIdr: sumIdr(lines.map((line) => line.settledNetIdr)),
    varianceIdr: sumIdr(lines.map((line) => line.varianceIdr)),
  });
}
