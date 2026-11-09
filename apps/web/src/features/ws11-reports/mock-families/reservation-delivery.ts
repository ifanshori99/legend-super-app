// Reservation and delivery families of the report viewer mock. The catalog has
// no delivery report yet, so no run is served for it.
import type { Atoms } from "../mock-day-model.ts";
import { count, ratio, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  bookings: { from: "tx", ratio: 0.2 },
  noShows: { from: "tx", ratio: 0.02 },
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
  delivery: [],
} as const;
