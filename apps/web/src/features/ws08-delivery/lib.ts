// Pure helpers for the delivery channel ops screen (bead legend-e8oa; PRD v1.7
// §3.23 "Integrasi Ojek Online" / F20, §4 Alur G, decision D12 "Mode Manual").
// No React and no `@/` imports, so a Node test can load this file with type
// stripping.
//
// Business rules stay in the contract (@starter/shared/delivery): the
// fulfilment state machine, the closing targets, the net amount and the
// injectability check are imported, never re-implemented here.
import {
  DELIVERY_ORDER_STATUSES,
  canTransitionDeliveryOrder,
  deliveryNetIdr,
  deliveryOrderIsInjectable,
} from "@starter/shared/delivery";
import type {
  DeliveryChannel,
  DeliveryChannelOrder,
  DeliveryLineModifier,
  DeliveryMappingStatus,
  DeliveryOrderSource,
  DeliveryOrderStatus,
  DeliveryPlatform,
  DeliveryPlatformSync,
  DeliverySettlementStatus,
  DeliverySyncStatus,
} from "@starter/shared/delivery";
import type { MessageKey } from "@starter/shared/i18n";

/** One page of incoming orders; "Muat lagi" appends the next cursor page. */
export const DELIVERY_ORDER_PAGE_SIZE = 25;

// ---- Labels ---------------------------------------------------------------

export function platformKey(platform: DeliveryPlatform): MessageKey {
  return `deliveryOps.platform.${platform}`;
}

export function orderStatusKey(status: DeliveryOrderStatus): MessageKey {
  return `deliveryOps.orderStatus.${status}`;
}

export function mappingStatusKey(status: DeliveryMappingStatus): MessageKey {
  return `deliveryOps.mapping.${status}`;
}

export function syncStatusKey(status: DeliverySyncStatus): MessageKey {
  return `deliveryOps.syncStatus.${status}`;
}

/** No later status step exists, so a `needs_action` mark cannot clear alone. */
export function orderIsFinal(status: DeliveryOrderStatus): boolean {
  return (
    status === "delivered" || status === "cancelled" || status === "rejected"
  );
}

export function platformSyncKey(
  sync: Exclude<DeliveryPlatformSync, "ok">,
): MessageKey {
  return `deliveryOps.platformSync.${sync}`;
}

export function settlementStatusKey(
  status: DeliverySettlementStatus,
): MessageKey {
  return `deliveryOps.settlementStatus.${status}`;
}

export function sourceKey(source: DeliveryOrderSource): MessageKey {
  return `deliveryOps.source.${source}`;
}

/**
 * Error text for a failed delivery call. The API returns a `DeliveryError`
 * code; anything else (network, validation) falls back to the generic hint.
 */
export function deliveryErrorKey(error: unknown): MessageKey {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case "DELIVERY_ORDER_DUPLICATE":
    case "DELIVERY_ORDER_NOT_FOUND":
    case "DELIVERY_TRANSITION_INVALID":
    case "DELIVERY_CHANNEL_CLOSED":
    case "DELIVERY_MAPPING_INCOMPLETE":
    case "DELIVERY_CHANNEL_UNKNOWN":
    case "DELIVERY_SYNC_NOT_PENDING":
      return `deliveryOps.errors.${code}`;
    default:
      return "deliveryOps.errors.fallback";
  }
}

// ---- Fulfilment actions ----------------------------------------------------

const ACTION_LABEL: Record<DeliveryOrderStatus, MessageKey> = {
  received: "deliveryOps.orderStatus.received",
  accepted: "deliveryOps.detail.accept",
  preparing: "deliveryOps.detail.actionPreparing",
  ready: "deliveryOps.detail.actionReady",
  picked_up: "deliveryOps.detail.actionPickedUp",
  delivered: "deliveryOps.detail.actionDelivered",
  cancelled: "deliveryOps.detail.cancel",
  rejected: "deliveryOps.detail.reject",
};

export type DeliveryOrderAction = {
  /** Target status of the contract machine. */
  readonly to: DeliveryOrderStatus;
  readonly labelKey: MessageKey;
  /** Cancelled and rejected ask for a reason (contract input refine). */
  readonly needsReason: boolean;
};

/**
 * Every step the fulfilment machine allows from `status`, in contract order
 * (received → accepted → preparing → ready → picked_up → delivered, with
 * reject/cancel). Pure so the Sheet and its tests share one source.
 */
export function orderActions(
  status: DeliveryOrderStatus,
): DeliveryOrderAction[] {
  return DELIVERY_ORDER_STATUSES.filter((to) =>
    canTransitionDeliveryOrder(status, to),
  ).map((to) => ({
    to,
    labelKey: ACTION_LABEL[to],
    needsReason: to === "cancelled" || to === "rejected",
  }));
}

/** Delivered, cancelled and rejected are final in the contract machine. */
export function orderIsFinished(status: DeliveryOrderStatus): boolean {
  return orderActions(status).length === 0;
}

/** An accepted order reaches the KDS only when every line maps (contract). */
export function orderCanEnterKitchen(order: DeliveryChannelOrder): boolean {
  return deliveryOrderIsInjectable(order);
}

export function orderHasPriceMismatch(order: DeliveryChannelOrder): boolean {
  return order.lines.some((line) => line.mapping === "price_mismatch");
}

/** A line staff must map before the order can reach the kitchen. */
export function lineNeedsMapping(line: DeliveryChannelOrder["lines"][number]) {
  return line.mapping === "unmatched" || line.mapping === "sold_out";
}

/** Any line that blocks the kitchen: unmatched, or matched to a sold-out item. */
export function orderHasUnmatchedLine(order: DeliveryChannelOrder): boolean {
  return order.lines.some(lineNeedsMapping);
}

/**
 * legend-5d76: a webhook order that did not match the menu waits for staff
 * (status `received`, no internal order yet, a line still unmatched or sold out).
 */
export function orderNeedsReview(order: DeliveryChannelOrder): boolean {
  return (
    order.status === "received" &&
    order.orderId === null &&
    orderHasUnmatchedLine(order)
  );
}

/** The "Perlu tindakan" filter of the order list. */
export function orderNeedsAttention(order: DeliveryChannelOrder): boolean {
  return order.platformSync === "needs_action" || orderNeedsReview(order);
}

// ---- Channel state --------------------------------------------------------

/**
 * D12 "Mode Manual": a platform with no successful sync and a failing
 * integration is still handled by recording its orders in the POS. Derived
 * from the channel row (never a hardcoded platform list), so the badge
 * disappears as soon as the partner integration syncs once.
 */
export function channelIsManual(channel: DeliveryChannel): boolean {
  return channel.syncStatus === "error" && channel.lastSyncedAt === null;
}

export type DeliveryReviewCounts = { priceMismatch: number; unmatched: number };

/**
 * Menu review hints of one platform, read from its live orders: a platform
 * price that differs from our channel price list and an order line with no
 * menu match. Sold-out items come from the channel row (`soldOutItemCount`).
 */
export function reviewCounts(
  orders: readonly DeliveryChannelOrder[],
  platform: DeliveryPlatform,
): DeliveryReviewCounts {
  let priceMismatch = 0;
  let unmatched = 0;
  for (const order of orders) {
    if (order.platform !== platform || orderIsFinished(order.status)) continue;
    for (const line of order.lines) {
      if (line.mapping === "price_mismatch") priceMismatch += 1;
      if (line.mapping === "unmatched") unmatched += 1;
    }
  }
  return { priceMismatch, unmatched };
}

// ---- Manual order lines (D12) ---------------------------------------------

/** Line price resolved from the channel price list; null while unknown. */
export type ManualOrderLineInput = {
  menuItemId: string | null;
  quantity: number;
  /** `channelPriceIdr` of the picked item, the client never sends money. */
  priceIdr: number | null;
};

/**
 * Informational total of the manual order draft. The API resolves every line
 * price from the platform price list, so this is never submitted.
 */
export function manualLinesTotal(lines: readonly ManualOrderLineInput[]): {
  totalIdr: number;
  complete: boolean;
} {
  let totalIdr = 0;
  let complete = true;
  for (const line of lines) {
    if (line.priceIdr === null) {
      complete = false;
      continue;
    }
    totalIdr += line.priceIdr * line.quantity;
  }
  return { totalIdr, complete };
}

export function modifiersSummary(
  modifiers: readonly DeliveryLineModifier[],
): string {
  return modifiers.map((modifier) => modifier.name).join(", ");
}

// ---- Money ---------------------------------------------------------------

/** Gross − commission from the contract helper, never a second formula. */
export function orderNetIdr(order: DeliveryChannelOrder): number {
  return deliveryNetIdr(order);
}

// ---- Business dates in the outlet time zone -------------------------------

/** Calendar date (`YYYY-MM-DD`) of one instant in the outlet's time zone. */
export function businessDateOf(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid instant");
  // en-CA formats as YYYY-MM-DD, the contract's business-date shape.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** The outlet's today as a business date. */
export function todayBusinessDate(
  timeZone: string,
  now: Date = new Date(),
): string {
  return businessDateOf(now.toISOString(), timeZone);
}

/** First day of the business date's month — the default reconciliation period. */
export function firstOfMonth(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new RangeError("Invalid business date");
  return `${date.slice(0, 7)}-01`;
}

/** Short date label, e.g. "1 Nov 2026". */
export function formatBusinessDate(date: string): string {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed)) return date;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(parsed));
}

/** Outlet clock, e.g. "12.42" — one locale and zone, so SSR matches. */
export function formatClock(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Date and outlet clock, e.g. "1 Nov 2026, 12.42". */
export function formatDateTime(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "1 Nov" for a compact table cell, with the clock supplied separately. */
export function formatDayShort(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "numeric",
    month: "short",
  }).format(date);
}
