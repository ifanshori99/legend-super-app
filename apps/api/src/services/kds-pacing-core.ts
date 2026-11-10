// Pure pacing rules (KDS-05, bead legend-gyc): active capacity rule, channel
// priority, delay and ETA math, auto-pause decision. No db access so the
// decisions are unit-testable; kds-pacing.service.ts feeds it rows.

import type { CapacityLevel } from "@starter/shared/kitchen";

import { withinWindows } from "./menu-availability.ts";

/** Lines with at least this prep time are paused when a station is full. */
export const LONG_PREP_SECONDS = 600;
/** Service time when a station has neither history nor line prep data. */
export const FALLBACK_SERVICE_SECONDS = 600;
/** Fewer done tickets than this is noise, so no history median. */
export const MIN_HISTORY_SAMPLES = 5;

export type PacingRule = {
  stationId: string;
  windowMinutes: number;
  capacityPoints: number;
  nearCapacityBp: number;
  schedule: { daysOfWeek: number[]; start: string; end: string }[];
  channelPriority: string[];
};

const LEVEL_ORDER: Record<CapacityLevel, number> = {
  available: 0,
  near_capacity: 1,
  at_capacity: 2,
};

/**
 * Rule in force at `at` (outlet wall clock). Overlapping rules: the tightest
 * window wins, then the larger capacity. No match means the station is not paced.
 */
export function pickActiveRule(
  rules: PacingRule[],
  at: Date,
  timeZone: string,
): PacingRule | null {
  const matching = rules.filter((rule) =>
    withinWindows(rule.schedule, at, timeZone, "closed"),
  );
  if (matching.length === 0) return null;
  return matching.reduce((best, rule) =>
    rule.windowMinutes < best.windowMinutes ||
    (rule.windowMinutes === best.windowMinutes &&
      rule.capacityPoints > best.capacityPoints)
      ? rule
      : best,
  );
}

/** Slot start: `at` floored to an epoch multiple of the window. */
export function windowStartFor(at: Date, windowMinutes: number): Date {
  const windowMs = windowMinutes * 60_000;
  return new Date(Math.floor(at.getTime() / windowMs) * windowMs);
}

/** Lower rank = higher priority; an unlisted channel ranks last. */
export function channelRank(
  channel: string,
  channelPriority: string[],
): number {
  const index = channelPriority.indexOf(channel);
  return index === -1 ? channelPriority.length : index;
}

/** Points a channel waits behind: queue items of equal or higher priority. */
export function queueAheadPoints(
  queue: { channel: string; points: number }[],
  channel: string,
  channelPriority: string[],
): number {
  const own = channelRank(channel, channelPriority);
  return queue.reduce(
    (sum, item) =>
      channelRank(item.channel, channelPriority) <= own
        ? sum + item.points
        : sum,
    0,
  );
}

/** Minutes to clear `aheadPoints` at the rule's throughput (capacity per window). */
export function stationDelayMinutes(i: {
  aheadPoints: number;
  capacityPoints: number;
  windowMinutes: number;
}): number {
  if (i.aheadPoints <= 0) return 0;
  const pointsPerMinute = i.capacityPoints / i.windowMinutes;
  return Math.ceil(i.aheadPoints / pointsPerMinute);
}

/** Median of the samples, or null when there are too few to trust. */
export function medianSeconds(samples: number[]): number | null {
  if (samples.length < MIN_HISTORY_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function serviceSeconds(i: {
  historyMedianSeconds: number | null;
  longestLinePrepSeconds: number | null;
}): number {
  const best = Math.max(
    i.historyMedianSeconds ?? 0,
    i.longestLinePrepSeconds ?? 0,
  );
  return best > 0 ? best : FALLBACK_SERVICE_SECONDS;
}

export function etaMinutes(i: {
  delayMinutes: number;
  serviceSeconds: number;
}): number {
  return Math.ceil((i.delayMinutes * 60 + i.serviceSeconds) / 60);
}

/** Customer-facing range: the estimate plus a margin of 2 min or 25%. */
export function etaRange(eta: number): {
  minMinutes: number;
  maxMinutes: number;
} {
  return {
    minMinutes: eta,
    maxMinutes: eta + Math.max(2, Math.ceil(eta * 0.25)),
  };
}

/**
 * Lines to pause at a full station: long-prep lines for every channel except
 * the top priority one. A single-channel priority list pauses nothing.
 */
export function decidePauses(i: {
  level: CapacityLevel;
  channelPriority: string[];
  lines: {
    menuItemId: string;
    variantId: string | null;
    prepSeconds: number;
  }[];
}): { menuItemId: string; variantId: string | null; channels: string[] }[] {
  if (i.level !== "at_capacity") return [];
  const channels = i.channelPriority.slice(1);
  if (channels.length === 0) return [];
  return i.lines
    .filter((line) => line.prepSeconds >= LONG_PREP_SECONDS)
    .map((line) => ({
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      channels: [...channels],
    }));
}

/** Alert only when the level got worse; no previous level counts as available. */
export function shouldAlert(
  prev: CapacityLevel | null,
  next: CapacityLevel,
): boolean {
  return LEVEL_ORDER[next] > LEVEL_ORDER[prev ?? "available"];
}

/**
 * `orders.channel` + service type -> menu channel (`channelSchema`). Same rule
 * as `posPriceChannel` in pos-order-pricing.ts, copied because that module
 * (through qr-order-pricing.ts) imports kds-pacing.service.ts: importing it
 * back would be a cycle. QR orders are always dine in (QR_PRICE_CHANNEL).
 */
export function orderPriceChannel(
  channel: string,
  serviceType: string,
):
  | "dine_in"
  | "takeaway"
  | "gofood"
  | "grabfood"
  | "shopeefood"
  | "reservation" {
  switch (channel) {
    case "gofood":
    case "grabfood":
    case "shopeefood":
    case "reservation":
      return channel;
    case "qr":
      return "dine_in";
    default:
      return serviceType === "dine_in" ? "dine_in" : "takeaway";
  }
}
