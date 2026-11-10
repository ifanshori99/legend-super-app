// Reservation and delivery families of the report viewer mock. Delivery
// reports are listed here; mock.ts serves them once it adds
// `reportsByPrefix.delivery` to SERVED_REPORTS (shared file, see the request).
import type { Atoms } from "../mock-day-model.ts";
import { count, idr, ratio, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  bookings: { from: "tx", ratio: 0.2 },
  noShows: { from: "tx", ratio: 0.02 },
  deliveryOrders: { from: "tx", ratio: 0.15 },
  deliverySales: { from: "net", ratio: 0.12 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  switch (metricCode) {
    case "reservation_count":
      return count(atoms.bookings);
    case "no_show_reservations":
      return count(atoms.noShows);
    case "reservation_no_show_pct":
      return ratio(atoms.noShows, atoms.bookings);
    case "delivery_orders":
      return count(atoms.deliveryOrders);
    case "delivery_sales":
      return idr(atoms.deliverySales);
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  reservation: [
    "reservation.bookings",
    "reservation.by_zone",
    "reservation.no_show",
    "reservation.peak_hours",
  ],
  delivery: [
    "delivery.orders",
    "delivery.channel_sales",
    "delivery.by_menu",
    "delivery.settlement",
  ],
} as const;

/** Metrics the API answers `unavailable` (metric registry): the mock shows no number. */
export const unavailableMetrics: ReadonlySet<string> = new Set([]);
