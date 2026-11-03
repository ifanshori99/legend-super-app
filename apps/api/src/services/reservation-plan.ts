// Pure helpers for reservations (PRD v1.7 §3.22; RSV-01): outlet-time-zone
// arithmetic, slot generation, table picking and request fingerprints. No
// database access, so they are unit-testable (test/reservation-plan.test.ts).
import { createHash } from "node:crypto";

const MINUTE = 60_000;

/** Offset (ms) of `timeZone` from UTC at the instant `ms`. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local `date` (YYYY-MM-DD) + `time` (HH:MM) in `timeZone`. */
export function zonedInstant(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  )
    throw new RangeError("Invalid local date or time");
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return new Date(guess - zoneOffsetMs(first, timeZone));
}

/** The business date (YYYY-MM-DD) of `instant` in the outlet time zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Local minutes since midnight and weekday (0 = Sunday) of an instant. */
export function localClock(
  instant: Date,
  timeZone: string,
): { dayOfWeek: number; minutes: number } {
  const date = localDate(instant, timeZone);
  const [hour, minute] = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(instant)
    .split(":")
    .map(Number);
  const [year, month, day] = date.split("-").map(Number);
  return {
    dayOfWeek: new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay(),
    minutes: (hour ?? 0) * 60 + (minute ?? 0),
  };
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
}

export type ZoneWindow = {
  readonly daysOfWeek: readonly number[];
  readonly start: string;
  readonly end: string;
};

const minutesOf = (time: string): number => {
  const [hour, minute] = time.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
};

/**
 * True when the whole slot `[start, start + duration)` sits inside one opening
 * window of the local day it starts on. A window whose end is not after its
 * start runs to midnight. PRD §3 F9 "a zone with no window never opens".
 */
export function slotInsideHours(
  start: Date,
  durationMinutes: number,
  hours: readonly ZoneWindow[],
  timeZone: string,
): boolean {
  const clock = localClock(start, timeZone);
  return hours.some((window) => {
    if (!window.daysOfWeek.includes(clock.dayOfWeek)) return false;
    const from = minutesOf(window.start);
    const rawTo = minutesOf(window.end);
    const to = rawTo > from ? rawTo : 24 * 60;
    return clock.minutes >= from && clock.minutes + durationMinutes <= to;
  });
}

/** Candidate start instants for one local date, every `intervalMinutes`. */
export function candidateStarts(
  date: string,
  hours: readonly ZoneWindow[],
  durationMinutes: number,
  intervalMinutes: number,
  timeZone: string,
): Date[] {
  const dayStart = zonedInstant(date, "00:00", timeZone);
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const starts = new Map<number, Date>();
  for (const window of hours) {
    if (!window.daysOfWeek.includes(dayOfWeek)) continue;
    const from = minutesOf(window.start);
    const rawTo = minutesOf(window.end);
    const to = rawTo > from ? rawTo : 24 * 60;
    for (
      let at = from;
      at + durationMinutes <= to;
      at += Math.max(5, intervalMinutes)
    ) {
      const instant = new Date(dayStart.getTime() + at * MINUTE);
      starts.set(instant.getTime(), instant);
    }
  }
  return [...starts.values()].sort((a, b) => a.getTime() - b.getTime());
}

export type FreeTable = {
  readonly id: string;
  readonly zoneId: string;
  readonly capacity: number;
};

/**
 * Picks the tables for a party: the smallest single table that fits, else the
 * fewest tables of one zone (largest first) whose seats add up, at most 10.
 * Null when nothing fits. Deterministic (ties break on id).
 */
export function pickTables(
  free: readonly FreeTable[],
  pax: number,
): FreeTable[] | null {
  const byFit = [...free].sort(
    (a, b) => a.capacity - b.capacity || a.id.localeCompare(b.id),
  );
  const single = byFit.find((table) => table.capacity >= pax);
  if (single) return [single];
  const zones = new Map<string, FreeTable[]>();
  for (const table of free) {
    const list = zones.get(table.zoneId) ?? [];
    list.push(table);
    zones.set(table.zoneId, list);
  }
  let best: FreeTable[] | null = null;
  for (const list of zones.values()) {
    const sorted = [...list].sort(
      (a, b) => b.capacity - a.capacity || a.id.localeCompare(b.id),
    );
    const chosen: FreeTable[] = [];
    let seats = 0;
    for (const table of sorted) {
      if (seats >= pax || chosen.length >= 10) break;
      chosen.push(table);
      seats += table.capacity;
    }
    if (seats >= pax && (best === null || chosen.length < best.length))
      best = chosen;
  }
  return best;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

/** SHA-256 of the operation and its canonical payload (idempotency binding). */
export function requestFingerprint(
  operation: string,
  parts: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ operation, ...parts })), "utf8")
    .digest("hex");
}
