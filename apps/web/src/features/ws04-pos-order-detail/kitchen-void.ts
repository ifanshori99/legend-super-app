// Pure helpers of the order detail screen (legend-0ixe): which lines the
// kitchen voided, and the bill rows. Relative imports only; Node tests load it
// directly. The kitchen void never changes the bill (the API appends an
// `order.kitchen_voided` event only), so the screen reads the event log.

import { remainingToPayIdr } from "../ws04-pos-kasir/payment-due.ts";

export type KitchenVoidEventInput = {
  id: string;
  type: string;
  payload: unknown;
  occurredAt: string;
  sequence: number;
};

export type KitchenVoidNotice = {
  eventId: string;
  occurredAt: string;
  /** Order lines the kitchen voided in this event. */
  itemIds: readonly string[];
  ticketCancelled: boolean;
  reason: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Notices from the order's event log, oldest first. A payload that does not
 * match `{ orderItemIds: string[], ticketCancelled, reason }` is skipped, never
 * guessed.
 */
export function kitchenVoidNotices(
  events: readonly KitchenVoidEventInput[],
): KitchenVoidNotice[] {
  const notices: KitchenVoidNotice[] = [];
  for (const event of events) {
    if (event.type !== "order.kitchen_voided") continue;
    const payload = record(event.payload);
    const ids = payload?.orderItemIds;
    if (!payload || !Array.isArray(ids)) continue;
    const itemIds = ids.filter((id): id is string => typeof id === "string");
    if (itemIds.length === 0) continue;
    const reason =
      typeof payload.reason === "string" && payload.reason.trim() !== ""
        ? payload.reason.trim()
        : null;
    notices.push({
      eventId: event.id,
      occurredAt: event.occurredAt,
      itemIds,
      ticketCancelled: payload.ticketCancelled === true,
      reason,
    });
  }
  return notices.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/**
 * Notices narrowed to lines still on the bill. A line the POS already voided is
 * settled: it drops out of its notice, and a notice left with no line is gone.
 */
export function openKitchenVoidNotices(
  notices: readonly KitchenVoidNotice[],
  items: readonly { id: string; status: string }[],
): KitchenVoidNotice[] {
  const open = new Set(
    items.filter((item) => item.status !== "voided").map((item) => item.id),
  );
  const result: KitchenVoidNotice[] = [];
  for (const notice of notices) {
    const itemIds = notice.itemIds.filter((id) => open.has(id));
    if (itemIds.length > 0) result.push({ ...notice, itemIds });
  }
  return result;
}

/** Ids of the lines in `notices` (use the output of `openKitchenVoidNotices`). */
export function kitchenVoidedItemIds(
  notices: readonly KitchenVoidNotice[],
): ReadonlySet<string> {
  return new Set(notices.flatMap((notice) => notice.itemIds));
}

export type BillRowKey =
  | "subtotal"
  | "discount"
  | "service"
  | "tax"
  | "rounding"
  | "total"
  | "deposit"
  | "remaining";
export type BillRow = { key: BillRowKey; amountIdr: number };

/** Money already captured by tenders (authorized, failed and voided do not count). */
export function capturedTendersIdr(
  tenders: readonly { status: string; amountIdr: number }[],
): number {
  return tenders
    .filter((tender) => tender.status === "captured")
    .reduce((sum, tender) => sum + tender.amountIdr, 0);
}

/**
 * Rows of the bill summary: subtotal and total always, every other row only
 * when it is not zero. Discount and DP show as negative figures. The reservation
 * DP is not a tender, so the balance ("Sisa") comes from `remainingToPayIdr`,
 * never from total minus tenders alone; it shows once a DP or a payment exists.
 */
export function billRows(order: {
  subtotalIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
  totalIdr: number;
  depositAppliedIdr: number;
  capturedIdr?: number;
}): BillRow[] {
  const rows: BillRow[] = [{ key: "subtotal", amountIdr: order.subtotalIdr }];
  if (order.discountIdr !== 0)
    rows.push({ key: "discount", amountIdr: -order.discountIdr });
  if (order.serviceChargeIdr !== 0)
    rows.push({ key: "service", amountIdr: order.serviceChargeIdr });
  if (order.taxIdr !== 0) rows.push({ key: "tax", amountIdr: order.taxIdr });
  if (order.roundingIdr !== 0)
    rows.push({ key: "rounding", amountIdr: order.roundingIdr });
  rows.push({ key: "total", amountIdr: order.totalIdr });
  const capturedIdr = order.capturedIdr ?? 0;
  if (order.depositAppliedIdr > 0)
    rows.push({ key: "deposit", amountIdr: -order.depositAppliedIdr });
  if (order.depositAppliedIdr > 0 || capturedIdr > 0)
    rows.push({
      key: "remaining",
      amountIdr: remainingToPayIdr({
        totalIdr: order.totalIdr,
        depositAppliedIdr: order.depositAppliedIdr,
        capturedIdr,
      }),
    });
  return rows;
}

/** "14.29": the clock time of an instant in the outlet's zone (id-ID style). */
export function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}
