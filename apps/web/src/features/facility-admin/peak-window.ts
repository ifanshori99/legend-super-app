// Pure helpers for the peak window end field (bead legend-1rmk). An
// <input type="time"> cannot hold "24:00", so the form shows it as "00:00" and
// maps it back when the body is built. Only the end of a window is mapped.
import { END_OF_DAY } from "@starter/shared/facility";

const MIDNIGHT = "00:00";

/** Stored window end to the time input value: "24:00" shows as "00:00". */
export function peakEndToInput(endsAt: string): string {
  return endsAt === END_OF_DAY ? MIDNIGHT : endsAt;
}

/** Time input value to the stored window end: "00:00" is "24:00". */
export function peakEndToBody(endsAt: string): string {
  return endsAt === MIDNIGHT ? END_OF_DAY : endsAt;
}
