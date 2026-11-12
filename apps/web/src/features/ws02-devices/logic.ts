// Pure rules of the device registry panel (bead legend-q2c; PRD v1.7 §3 F5
// "Registri Perangkat", "Mode Latihan"; EDG-03 UI; EDG-05 30 s offline). No
// framework imports, so tests can load it with plain Node ESM.
import type { Device } from "@starter/shared/edge";
import type { MessageKey } from "@starter/shared/i18n";
import { DEVICE_OFFLINE_AFTER_MS } from "../ws02-edge/logic.ts";

/**
 * A heartbeat older than this is late but not yet an outage. INVENTED: half
 * of the EDG-05 30 s offline limit (two missed 5-15 s beats); the PRD names
 * only the 30 s limit.
 */
export const DEVICE_STALE_AFTER_MS = 15_000;
export { DEVICE_OFFLINE_AFTER_MS };

export type HeartbeatState =
  "online" | "stale" | "offline" | "never" | "revoked";

export function heartbeatAgeMs(device: Device, nowMs: number): number | null {
  if (device.lastSeenAt === null) return null;
  const seen = Date.parse(device.lastSeenAt);
  if (Number.isNaN(seen)) return null;
  return Math.max(0, nowMs - seen);
}

export function heartbeatState(device: Device, nowMs: number): HeartbeatState {
  if (device.status === "revoked") return "revoked";
  const age = heartbeatAgeMs(device, nowMs);
  if (age === null) return "never";
  if (age >= DEVICE_OFFLINE_AFTER_MS) return "offline";
  if (age >= DEVICE_STALE_AFTER_MS) return "stale";
  return "online";
}

/** Difference between the server clock and viewer clock at response receipt. */
export function serverClockOffsetMs(
  serverTime: string,
  receivedAtMs: number,
): number {
  const serverMs = Date.parse(serverTime);
  return Number.isFinite(serverMs) ? serverMs - receivedAtMs : 0;
}

export type AgeParts =
  | { key: "justNow" }
  | {
      key: "ageSeconds" | "ageMinutes" | "ageHours" | "ageDays";
      count: number;
    };

export function splitAge(ms: number): AgeParts {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return { key: "justNow" };
  if (seconds < 60) return { key: "ageSeconds", count: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: "ageMinutes", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { key: "ageHours", count: hours };
  return { key: "ageDays", count: Math.floor(hours / 24) };
}

export const DEVICE_TYPE_LABEL: Record<Device["type"], MessageKey> = {
  pos: "deviceRegistry.type.pos",
  kds: "deviceRegistry.type.kds",
  waiter_phone: "deviceRegistry.type.waiter_phone",
  printer: "deviceRegistry.type.printer",
  display: "deviceRegistry.type.display",
  smart_lock: "deviceRegistry.type.smart_lock",
  panic_button: "deviceRegistry.type.panic_button",
  edc: "deviceRegistry.type.edc",
};

export const DEVICE_TYPES = Object.keys(DEVICE_TYPE_LABEL) as Device["type"][];

export const HEARTBEAT_LABEL: Record<HeartbeatState, MessageKey> = {
  online: "deviceRegistry.heartbeat.online",
  stale: "deviceRegistry.heartbeat.stale",
  offline: "deviceRegistry.heartbeat.offline",
  never: "deviceRegistry.heartbeat.never",
  revoked: "deviceRegistry.heartbeat.revoked",
};

export const HEARTBEAT_HINT: Record<HeartbeatState, MessageKey | null> = {
  online: null,
  stale: "deviceRegistry.heartbeat.staleHint",
  offline: "deviceRegistry.heartbeat.offlineHint",
  never: "deviceRegistry.heartbeat.neverHint",
  revoked: "deviceRegistry.heartbeat.revokedHint",
};

export type RegistryFilters = {
  search: string;
  outletId: string;
  type: string;
  status: string;
};
export const ALL = "all";
export const EMPTY_FILTERS: RegistryFilters = {
  search: "",
  outletId: ALL,
  type: ALL,
  status: ALL,
};

export function filterDevices(
  devices: readonly Device[],
  filters: RegistryFilters,
): Device[] {
  const needle = filters.search.trim().toLowerCase();
  return devices.filter(
    (d) =>
      (filters.outletId === ALL || d.outletId === filters.outletId) &&
      (filters.type === ALL || d.type === filters.type) &&
      (filters.status === ALL || d.status === filters.status) &&
      (needle === "" || d.label.toLowerCase().includes(needle)),
  );
}

export function deviceCounts(devices: readonly Device[], nowMs: number) {
  const counts = { total: devices.length, online: 0, attention: 0, revoked: 0 };
  for (const d of devices) {
    const state = heartbeatState(d, nowMs);
    if (state === "online") counts.online += 1;
    else if (state === "revoked") counts.revoked += 1;
    else counts.attention += 1;
  }
  return counts;
}

/** Typed confirmation: the operator types the device name (case-insensitive). */
export function revokeConfirmationMatches(
  input: string,
  label: string,
): boolean {
  return input.trim().toLowerCase() === label.trim().toLowerCase();
}

export const REVOKE_REASON_MIN = 3;
export function revokeReasonValid(reason: string): boolean {
  return reason.trim().length >= REVOKE_REASON_MIN;
}

/**
 * Devices revoked in this session overlay the polled list until the server
 * list catches up, so a revoked row never flips back to "active".
 */
export function mergeRevocations(
  devices: readonly Device[],
  revoked: ReadonlyMap<string, Device>,
): Device[] {
  return devices.map((d) => {
    const override = revoked.get(d.id);
    return override && d.status === "active" ? override : d;
  });
}

/**
 * Offer listed outlets even when they contain no devices. The server checks
 * device.registry.manage on the selected outlet before returning its rows.
 */
export function outletOptions(
  orgOutlets: readonly { id: string; name: string }[],
  devices: readonly Device[],
): { id: string; name: string | null }[] {
  const names = new Map(orgOutlets.map((o) => [o.id, o.name] as const));
  const seen = new Map<string, string | null>(
    orgOutlets.map((o) => [o.id, o.name]),
  );
  for (const d of devices)
    if (!seen.has(d.outletId))
      seen.set(d.outletId, names.get(d.outletId) ?? null);
  return [...seen].map(([id, name]) => ({ id, name }));
}

export function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

/** Enroll form: a non-empty name that fits the API's 255 character limit. */
export function enrollLabelValid(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length >= 1 && trimmed.length <= 255;
}
