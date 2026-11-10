// Pure helpers of the guest Wi-Fi captive portal (bead legend-g9r3; PRD v1.7
// §3 Kelompok C "Wi-Fi Tamu & WFC", §4 Alur X, FAC-11/FAC-12/FAC-13).
//
// No React and no DOM at import time, and only relative or bare package
// imports, so tests/ws09-wifi.test.mjs loads this file with Node type
// stripping. The numbers shown on screen always come from the zone's
// `wifi_policies` row; this file only formats and derives from it.

import type { MessageKey, Translate } from "@starter/shared/i18n";
import {
  wifiQuotaMinutes,
  type PeakWindow,
  type WifiPolicy,
  type WifiSpeedTier,
} from "@starter/shared/facility";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

/** PRD §3 "Wi-Fi Berbasis Belanja": reminder 15 minutes before the quota ends. */
export const WIFI_REMINDER_MINUTES = 15;

/**
 * FAC-12: the quota must rise within a minute of a paid transaction, so the
 * portal re-reads its session at least twice a minute.
 */
export const WIFI_QUOTA_POLL_MS = 30_000;

/** Where this browser remembers its device id (never sent raw, see below). */
export const WIFI_DEVICE_STORAGE_KEY = "legend-wifi-device";
export const DEVICE_FINGERPRINT_MAX_LENGTH = 512;

/** FAC-13: the terminal state of a spent quota is the base speed, never "off". */
export function isThrottled(tier: WifiSpeedTier): boolean {
  return tier === "base";
}

/** PRD §4 Alur X step 4: remind once 15 minutes (or less) are left. */
export function shouldRemind(remainingMinutes: number): boolean {
  if (!Number.isFinite(remainingMinutes)) return false;
  return remainingMinutes > 0 && remainingMinutes <= WIFI_REMINDER_MINUTES;
}

/** 255 → "4 jam 15 menit", 45 → "45 menit", 120 → "2 jam". */
export function formatMinutes(minutes: number, t: Translate): string {
  const total = Math.max(0, Math.trunc(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return t("wifi.minutes", { minutes: rest });
  if (rest === 0) return t("wifi.hours", { hours });
  return t("wifi.hoursMinutes", { hours, minutes: rest });
}

/** "11:30" → "11.30" (Indonesian clock style, as printed on menus and signs). */
export function formatClock(timeOfDay: string): string {
  return timeOfDay.replace(":", ".");
}

const DAY_KEYS = [
  "wifi.daysShort.sun",
  "wifi.daysShort.mon",
  "wifi.daysShort.tue",
  "wifi.daysShort.wed",
  "wifi.daysShort.thu",
  "wifi.daysShort.fri",
  "wifi.daysShort.sat",
] as const satisfies readonly MessageKey[];

/**
 * Weekday numbers follow the contract's `wallClockAt` convention (0 Sunday).
 * Consecutive runs collapse: [1,2,3,4,5] → "Sen–Jum", [0,6] → "Min, Sab".
 */
export function formatDays(
  daysOfWeek: readonly number[],
  t: Translate,
): string {
  const days = [...new Set(daysOfWeek)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  const groups: string[] = [];
  let start = 0;
  while (start < days.length) {
    let end = start;
    while (end + 1 < days.length && days[end + 1] === days[end] + 1) end += 1;
    const from = t(DAY_KEYS[days[start]]);
    const to = t(DAY_KEYS[days[end]]);
    groups.push(start === end ? from : t("wifi.dayRange", { from, to }));
    start = end + 1;
  }
  return groups.join(", ");
}

/**
 * Every peak window of the zone, grouped by its days so the same weekdays are
 * not repeated: "Sen–Jum 11.30–14.00, 18.00–21.00 · Min, Sab 00.00–24.00".
 */
export function formatPeakWindows(
  windows: readonly PeakWindow[],
  t: Translate,
): string {
  const groups = new Map<string, string[]>();
  for (const window of windows) {
    const days = formatDays(window.daysOfWeek, t);
    const range = t("wifi.peakRange", {
      start: formatClock(window.startsAt),
      end: formatClock(window.endsAt),
    });
    const ranges = groups.get(days) ?? [];
    ranges.push(range);
    groups.set(days, ranges);
  }
  return [...groups.entries()]
    .map(([days, ranges]) =>
      t("wifi.peakWindow", { days, times: ranges.join(", ") }),
    )
    .join(" · ");
}

const TIER_TERMS: Record<string, MessageKey> = {
  silver: "terms.tierSilver",
  gold: "terms.tierGold",
  platinum: "terms.tierPlatinum",
};

function tierName(key: string, t: Translate): string {
  const term = TIER_TERMS[key.toLowerCase()];
  if (term) return t(term);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** "Gold 1 jam, Platinum 2 jam" — the tier bonus configured on the policy. */
export function formatTierBonuses(
  bonusMinutes: Readonly<Record<string, number>>,
  t: Translate,
): string {
  return Object.entries(bonusMinutes)
    .sort(([, left], [, right]) => right - left)
    .map(([key, minutes]) =>
      t("wifi.tierValue", {
        tier: tierName(key, t),
        minutes: formatMinutes(minutes, t),
      }),
    )
    .join(", ");
}

/** FAC-12: free minutes for the moment plus one extra hour per spend step. */
export function dailyQuotaMinutes(
  policy: WifiPolicy,
  input: { isPeak: boolean; sameDaySpendIdr: number },
): number {
  return wifiQuotaMinutes(policy, input);
}

/**
 * A stable fingerprint of this browser, sent to the API which hashes it before
 * storing (the raw value never reaches the database). The random id lives in
 * localStorage so the same device is recognised on the next visit (FAC-12:
 * max devices per account). Never uses the IP or any personal data.
 */
export function buildDeviceFingerprint(input: {
  deviceId: string;
  userAgent: string;
  width: number;
  height: number;
}): string {
  return `${input.deviceId}|${input.userAgent}|${input.width}x${input.height}`.slice(
    0,
    DEVICE_FINGERPRINT_MAX_LENGTH,
  );
}

function randomDeviceId(): string {
  return newIdempotencyKey();
}

/** Browser only (called from the connect mutation, never during render). */
export function deviceFingerprint(): string {
  let deviceId: string;
  try {
    deviceId = localStorage.getItem(WIFI_DEVICE_STORAGE_KEY) ?? "";
    if (!deviceId) {
      deviceId = randomDeviceId();
      localStorage.setItem(WIFI_DEVICE_STORAGE_KEY, deviceId);
    }
  } catch {
    // Private mode or blocked storage: still connect, just without a stable id.
    deviceId = randomDeviceId();
  }
  return buildDeviceFingerprint({
    deviceId,
    userAgent: navigator.userAgent,
    width: window.screen?.width ?? 0,
    height: window.screen?.height ?? 0,
  });
}

/**
 * The table menu the guest can always open, with or without a Wi-Fi session
 * (FAC-11: ordering and payment pages never sit behind the Wi-Fi login). The
 * token comes from the QR that opened the portal; the Wi-Fi sticker has none,
 * so the portal then explains where to scan instead.
 */
export function tableMenuToken(tableToken: string | undefined): string | null {
  const token = tableToken?.trim();
  return token ? token : null;
}

/**
 * What the connect button says when the API refuses (FAC-12). Reads the error
 * `code` without importing the client, so the mapping is unit-testable.
 */
export function startErrorMessage(
  error: unknown,
  maxDevices: number,
  t: Translate,
): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "WIFI_DEVICE_LIMIT")
    return t("wifi.deviceLimitError", { devices: maxDevices });
  return t("wifi.connectError");
}
