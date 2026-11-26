// Pure shaping of the open orders list (brief 1268 W5): which statuses the tab
// "Belum selesai" asks for, one row per server summary, one row per parked cart.
// Money is shown only as the server sent it; a parked cart has no price at all
// (its prices are computed when it is resumed and sent), so its row has none.
import type {
  PosOrderStatus,
  PosOrderSummary,
  PosParkedOrder,
} from "@starter/shared/pos";

/** Orders not final yet: not sent to the shift, waiting for money, or sent. */
export const OPEN_ORDER_STATUSES = [
  "draft",
  "awaiting_payment",
  "sent",
] as const satisfies readonly PosOrderStatus[];

export type OpenOrderStatus = (typeof OPEN_ORDER_STATUSES)[number];

export type OpenOrderRow = {
  id: string;
  number: string;
  /** The table label, or null: the screen shows the service type instead. */
  tableLabel: string | null;
  serviceType: PosOrderSummary["serviceType"];
  status: OpenOrderStatus;
  itemCount: number;
  heldItemCount: number;
  totalIdr: number;
  remainingIdr: number;
  /** Part of the bill is paid already (deposit, tender or payment link). */
  partlyPaid: boolean;
  createdAt: string;
};

export type ParkedRow = {
  id: string;
  label: string;
  serviceType: PosParkedOrder["serviceType"];
  itemCount: number;
  parkedAt: string;
};

function isOpenStatus(status: PosOrderStatus): status is OpenOrderStatus {
  return (OPEN_ORDER_STATUSES as readonly PosOrderStatus[]).includes(status);
}

/** List rows, in the server's order; a row that became final is left out. */
export function toOpenOrderRows(
  summaries: readonly PosOrderSummary[],
): OpenOrderRow[] {
  return summaries.flatMap((summary) =>
    isOpenStatus(summary.status)
      ? [
          {
            id: summary.id,
            number: summary.number,
            tableLabel: summary.tableLabel,
            serviceType: summary.serviceType,
            status: summary.status,
            itemCount: summary.itemCount,
            heldItemCount: summary.heldItemCount,
            totalIdr: summary.totalIdr,
            remainingIdr: summary.remainingIdr,
            partlyPaid: summary.remainingIdr < summary.totalIdr,
            createdAt: summary.createdAt,
          },
        ]
      : [],
  );
}

/** How many orders still hold items back from the kitchen. */
export function ordersWithHeldItems(rows: readonly OpenOrderRow[]): number {
  return rows.filter((row) => row.heldItemCount > 0).length;
}

/** Parked carts carry no price: only the label, service and line count. */
export function toParkedRows(parked: readonly PosParkedOrder[]): ParkedRow[] {
  return parked.map((entry) => ({
    id: entry.id,
    label: entry.label,
    serviceType: entry.serviceType,
    itemCount: entry.items.length,
    parkedAt: entry.parkedAt,
  }));
}

/**
 * "4 menit lalu": whole minutes since the order opened, then whole hours.
 * Null for a future time (a clock off by a little) or under a minute.
 */
export function minutesAgo(
  iso: string,
  now: Date,
): { unit: "minute" | "hour"; count: number } | null {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  if (minutes < 60) return { unit: "minute", count: minutes };
  return { unit: "hour", count: Math.floor(minutes / 60) };
}

/**
 * The list remembers payments the order detail does not count yet (a paid
 * link from an older flow, review B2 P3-4). When the list says less is left
 * than the detail computes, the detail shows the list's figure as a warning
 * and never asks for the difference again on its own.
 */
export function oldLinkRemainingIdr(
  detailRemainingIdr: number,
  summary: Pick<OpenOrderRow, "remainingIdr"> | undefined,
): number | null {
  if (!summary) return null;
  return summary.remainingIdr < detailRemainingIdr
    ? summary.remainingIdr
    : null;
}
