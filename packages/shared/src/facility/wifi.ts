// Wi-Fi quota engine, contract level (PRD v1.7 §3 F39 Wi-Fi Berbasis Belanja,
// §6 K wifi_policies / wifi_sessions, FAC-12/FAC-13/FAC-14).
//
// Owner decisions baked in as defaults, not as code: the guest gets 2 hours
// free per day (1 hour in peak hours), plus 1 hour for every full Rp30.000 of
// paid F&B spend on that day, plus the tier bonus; the connection is never cut
// when the quota runs out — it drops to the policy's base speed. Every number
// is a `wifi_policies` row the admin panel edits without a redeploy (FAC-14).
//
// The engine is pure: the BE service (bead legend-kmd3) computes the daily
// window, the edge applies the speed tier, and the captive portal shows the
// same numbers (bead legend-g9r3).

import { FacilityError } from "./errors.ts";
import type {
  WifiPolicy,
  WifiSession,
  WifiSpeedTier,
  WifiSpendMode,
} from "./schemas.ts";
import { minutesOfDay, wallClockAt, windowEndMinutes } from "./slots.ts";

/** PRD §3 F39 / D38 defaults, used by the Legend fixtures and the BE seed. */
export const WIFI_POLICY_DEFAULTS = Object.freeze({
  freeMinutes: 120,
  peakFreeMinutes: 60,
  spendPerExtraHourIdr: 30_000,
  extraMinutes: 60,
  maxDevices: 2,
});

/**
 * FAC-14: peak windows come from the policy row, evaluated against the outlet
 * time zone, so an admin change applies on the next request.
 */
export function isPeakAt(
  policy: Pick<WifiPolicy, "peakSchedule">,
  instant: Date | string,
  timeZone: string,
): boolean {
  const clock = wallClockAt(instant, timeZone);
  return policy.peakSchedule.some(
    (window) =>
      window.daysOfWeek.includes(clock.dayOfWeek) &&
      clock.minutesOfDay >= minutesOfDay(window.startsAt) &&
      clock.minutesOfDay < windowEndMinutes(window.endsAt),
  );
}

/** Free minutes for one day: off-peak or peak allowance plus the tier bonus. */
export function wifiFreeMinutes(
  policy: Pick<
    WifiPolicy,
    "freeMinutes" | "peakFreeMinutes" | "tierBonusMinutes"
  >,
  input: { isPeak: boolean; tierKey?: string },
): number {
  const base = input.isPeak ? policy.peakFreeMinutes : policy.freeMinutes;
  const bonus =
    input.tierKey === undefined
      ? 0
      : (policy.tierBonusMinutes[input.tierKey] ?? 0);
  return base + bonus;
}

/**
 * FAC-12: every full `spendPerExtraHourIdr` of paid spend adds `extraMinutes`.
 * Cumulative for the business day: recompute after a payment lands instead of
 * adding per order, so the same order cannot grant minutes twice.
 * Rp45.000 grants 1 hour; Rp90.000 grants 3 hours (owner decision).
 */
export function wifiExtraMinutesForSpend(
  policy: Pick<WifiPolicy, "spendPerExtraHourIdr" | "extraMinutes">,
  spendIdr: number,
): number {
  if (!Number.isSafeInteger(spendIdr) || spendIdr < 0)
    throw new RangeError(`Invalid spend: ${spendIdr}`);
  if (policy.spendPerExtraHourIdr <= 0)
    throw new FacilityError(
      "WIFI_POLICY_INVALID",
      "Kebijakan Wi-Fi tidak memiliki ambang belanja.",
    );
  const steps = Math.floor(spendIdr / policy.spendPerExtraHourIdr);
  return steps * policy.extraMinutes;
}

/**
 * Extra minutes for a day's paid spend under the policy's `spendMode`
 * (legend-kmd3). `per_day_multiple` (the default when the policy has no mode)
 * floors the whole day's net spend; `per_order` floors each order's net spend
 * (paid minus its refunds) on its own, so Rp20.000 + Rp20.000 earns nothing.
 * Net amounts below zero count as zero.
 */
export function wifiExtraMinutesForOrders(
  policy: Pick<WifiPolicy, "spendPerExtraHourIdr" | "extraMinutes"> & {
    spendMode?: WifiSpendMode | undefined;
  },
  orderNetSpendIdr: readonly number[],
): number {
  const nets = orderNetSpendIdr.map((net) => Math.max(0, net));
  if (policy.spendMode === "per_order")
    return nets.reduce(
      (sum, net) => sum + wifiExtraMinutesForSpend(policy, net),
      0,
    );
  return wifiExtraMinutesForSpend(
    policy,
    nets.reduce((sum, net) => sum + net, 0),
  );
}

/**
 * A daily allowance never exceeds one day. Without the cap a large bill
 * (Rp1.000.000 = 33 extra hours at the default rule) would produce a quota the
 * session row and the `wifi_quota.updated` payload (0..1440) reject.
 */
export const WIFI_MAX_DAILY_MINUTES = 1440;

/** Whole daily allowance: free minutes for the moment, tier bonus and spend, capped at one day. */
export function wifiQuotaMinutes(
  policy: Pick<
    WifiPolicy,
    | "freeMinutes"
    | "peakFreeMinutes"
    | "tierBonusMinutes"
    | "spendPerExtraHourIdr"
    | "extraMinutes"
  >,
  input: { isPeak: boolean; tierKey?: string; sameDaySpendIdr: number },
): number {
  return Math.min(
    WIFI_MAX_DAILY_MINUTES,
    wifiFreeMinutes(policy, input) +
      wifiExtraMinutesForSpend(policy, input.sameDaySpendIdr),
  );
}

/** Like `wifiQuotaMinutes`, from per-order net spend and the policy's mode. */
export function wifiQuotaMinutesForOrders(
  policy: Parameters<typeof wifiQuotaMinutes>[0] & {
    spendMode?: WifiSpendMode | undefined;
  },
  input: {
    isPeak: boolean;
    tierKey?: string;
    orderNetSpendIdr: readonly number[];
  },
): number {
  return Math.min(
    WIFI_MAX_DAILY_MINUTES,
    wifiFreeMinutes(policy, input) +
      wifiExtraMinutesForOrders(policy, input.orderNetSpendIdr),
  );
}

/**
 * FAC-13: when the quota is spent the session drops to the base speed. There is
 * no "disconnected" tier: throttling is the terminal state of a day's session.
 */
export function wifiSpeedTier(
  usedMinutes: number,
  quotaMinutes: number,
): WifiSpeedTier {
  if (!Number.isInteger(usedMinutes) || usedMinutes < 0)
    throw new RangeError(`Invalid used minutes: ${usedMinutes}`);
  if (!Number.isInteger(quotaMinutes) || quotaMinutes < 0)
    throw new RangeError(`Invalid quota minutes: ${quotaMinutes}`);
  return usedMinutes < quotaMinutes ? "full" : "base";
}

/** Minutes left before throttling; 0 while throttled, never negative. */
export function wifiRemainingMinutes(
  session: Pick<WifiSession, "quotaMinutes" | "usedMinutes">,
): number {
  return Math.max(0, session.quotaMinutes - session.usedMinutes);
}

/**
 * FAC-12 / D37: at most `maxDevices` per account (PRD default 2). The caller
 * counts the account's active device sessions. A device that already holds one
 * of them is re-authorised (portal reload, roaming between access points) and
 * never counts against itself; only a new device needs a free place.
 */
export function assertWifiDeviceAllowed(
  activeDevices: number,
  policy: Pick<WifiPolicy, "maxDevices">,
  options: { deviceAlreadyActive?: boolean } = {},
): void {
  if (!Number.isInteger(activeDevices) || activeDevices < 0)
    throw new RangeError(`Invalid active device count: ${activeDevices}`);
  if (options.deviceAlreadyActive === true) {
    if (activeDevices > policy.maxDevices)
      throw new FacilityError(
        "WIFI_DEVICE_LIMIT",
        "Jumlah perangkat untuk akun ini sudah mencapai batas.",
      );
    return;
  }
  if (activeDevices >= policy.maxDevices)
    throw new FacilityError(
      "WIFI_DEVICE_LIMIT",
      "Jumlah perangkat untuk akun ini sudah mencapai batas.",
    );
}
