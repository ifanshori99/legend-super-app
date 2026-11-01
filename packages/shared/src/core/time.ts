// Date and time rules for DTOs (PRD §6: TIMESTAMPTZ, shown in Asia/Jakarta).
// - Instants (created_at, paid_at, occurred_at): ISO 8601 with an offset. The
//   server always emits UTC with milliseconds ("2026-11-01T13:00:00.000Z");
//   clients may send any offset. A string without an offset is rejected.
// - Business dates (business day, payroll period, report date): "YYYY-MM-DD",
//   a calendar date in the outlet's time zone, never an instant.
// - Times of day (opening hours, shift start): "HH:mm", outlet-local.
// - Time zone: IANA name per outlet (outlets.timezone), default Asia/Jakarta.
// The server derives business dates; clients never compute them from local
// device time.

import { z } from "zod";

export const DEFAULT_TIME_ZONE = "Asia/Jakarta";

export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const businessDateSchema = z.iso.date();
export const timeOfDaySchema = z.iso.time({ precision: -1 });
export const timeZoneSchema = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA time zone");

export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type BusinessDate = z.infer<typeof businessDateSchema>;
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

/** Serializes an instant the way the API emits it (UTC, milliseconds). */
export function toIsoDateTime(instant: Date): IsoDateTime {
  return instant.toISOString();
}

/** Calendar date of an instant in a time zone, e.g. the outlet's business date. */
export function businessDateOf(
  instant: Date | string,
  timeZone: string = DEFAULT_TIME_ZONE,
): BusinessDate {
  const date =
    typeof instant === "string"
      ? new Date(isoDateTimeSchema.parse(instant))
      : instant;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
