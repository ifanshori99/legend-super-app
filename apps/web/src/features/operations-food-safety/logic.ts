// Pure helpers for the food-safety screens (bead legend-d983): temperature
// parsing and range checks, outlet wall-clock formatting, the use-by
// suggestion and user labels. No React, so the rules stay testable and the
// server render and the browser render agree (docs/frontend.md "Server
// rendering with data").
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  decimal4Schema,
  parseDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import { formatNumber } from "@starter/shared/i18n";
import { isTemperatureInRange } from "@starter/shared/operations";
import type { TemperatureThreshold } from "@starter/shared/operations";

/** Locale fixed so SSR and hydration format identically (D-CORE-6). */
const LOCALE = "id-ID";

/** "3,5" / "3.5" / "-18" → a NUMERIC(14,4) string, or null when invalid. */
export function normalizeReadingInput(value: string): Decimal4 | null {
  const trimmed = value.trim().replace(",", ".");
  if (trimmed === "") return null;
  const parsed = decimal4Schema.safeParse(trimmed);
  return parsed.success ? parsed.data : null;
}

/**
 * OPS-02: is the reading outside the equipment threshold? Null when the input
 * or threshold cannot be read (the form shows its own invalid-value message).
 */
export function readingOutOfRange(
  value: string,
  threshold: TemperatureThreshold | null | undefined,
): boolean | null {
  const reading = normalizeReadingInput(value);
  if (reading === null || !threshold) return null;
  return !isTemperatureInRange(reading, threshold);
}

/** "3,5" — whole readings stay whole ("-18"), others keep one decimal. */
export function formatTemperature(value: string): string {
  const parsed = decimal4Schema.safeParse(value);
  if (!parsed.success) return value;
  const number = Number(parsed.data);
  if (!Number.isFinite(number)) return value;
  return formatNumber(number, {
    fractionDigits: Number.isInteger(number) ? 0 : 1,
  });
}

/** Planned/actual quantities: at most two decimals, no trailing zeros. */
export function formatQuantity(value: string): string {
  const parsed = decimal4Schema.safeParse(value);
  if (!parsed.success) return value;
  const number = Number(parsed.data);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(
    number,
  );
}

/** Threshold label arguments for the catalog's `rangeValue` key. */
export function thresholdRange(threshold: TemperatureThreshold): {
  min: string;
  max: string;
} {
  return {
    min: formatTemperature(threshold.minCelsius),
    max: formatTemperature(threshold.maxCelsius),
  };
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    wallFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClock(date: Date, timeZone: string): WallClock {
  const parts = wallFormatter(timeZone).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** An instant as a `datetime-local` value on the outlet's wall clock. */
export function toDateTimeLocalValue(date: Date, timeZone: string): string {
  const wall = wallClock(date, timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** Parses a `datetime-local` value on the outlet's wall clock to an ISO instant. */
export function fromDateTimeLocalValue(
  value: string,
  timeZone: string,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(asUtc)) return null;
  const offsetAt = (instant: number) => {
    const wall = wallClock(new Date(instant), timeZone);
    return (
      Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) -
      instant
    );
  };
  let instant = asUtc - offsetAt(asUtc);
  instant = asUtc - offsetAt(instant);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(LOCALE, { timeZone, ...options });
    cache.set(key, found);
  }
  return found;
}

/** `08.05` in the outlet time zone (SSR and browser agree). */
export function formatClock(instant: string, timeZone: string): string {
  return formatter(clockFormatters, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

/** `3 Nov 2026, 08.05` in the outlet time zone. */
export function formatDateTime(instant: string, timeZone: string): string {
  return formatter(clockFormatters, timeZone, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

const businessDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** `1 Nov 2026` from a business date, formatted at noon UTC so no zone slips. */
export function formatBusinessDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return businessDate;
  return businessDateFormatter.format(
    new Date(Date.UTC(year, month - 1, day, 12)),
  );
}

/** `…7951` — the tail that distinguishes two fixture UUIDs. */
export function shortId(value: string): string {
  return `…${value.slice(-8)}`;
}

type KnownPerson = { id: string; displayName: string };

let knownPeople: Map<string, string> | null = null;

/**
 * Display name for a user id while the API has no user-directory endpoint
 * (follow-up bead). The shared access fixtures are the only name source the
 * web app has today; an unknown id falls back to its short tail, never a
 * fabricated name.
 */
export function personName(userId: string): string | null {
  if (knownPeople === null) {
    knownPeople = new Map(
      Object.values(
        cafeLegendAccessFixtures.users as Record<string, KnownPerson>,
      ).map((person) => [person.id, person.displayName]),
    );
  }
  return knownPeople.get(userId) ?? null;
}

/**
 * Suggested use-by for a new prep label: the batch's expiry date at the
 * produced time. The contract has no shelf-life field, so the safest
 * suggestion never exceeds the inventory batch expiry; an expired batch
 * yields no suggestion (the user must type a valid use-by, OPS-03).
 */
export function suggestUseBy(
  producedAtIso: string,
  expiresOn: string | null,
  timeZone: string,
): string | null {
  if (expiresOn === null) return null;
  const produced = wallClock(new Date(producedAtIso), timeZone);
  const [year, month, day] = expiresOn.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return null;
  const suggestion = fromDateTimeLocalValue(
    `${expiresOn}T${pad(produced.hour)}:${pad(produced.minute)}`,
    timeZone,
  );
  if (suggestion === null) return null;
  return Date.parse(suggestion) > Date.parse(producedAtIso) ? suggestion : null;
}

/** Positive NUMERIC(14,4) check for the prep-list quantity fields. */
export function isPositiveQuantity(value: string): boolean {
  const normalized = normalizeReadingInput(value);
  if (normalized === null) return false;
  try {
    return parseDecimal4(normalized) > 0n;
  } catch {
    return false;
  }
}
