// Pure attendance rules (WS-10, PRD F25 / HR-02). No database, no clock reads:
// every function takes `now` or the instants it needs, so the service layer
// and the unit tests share one deterministic implementation.
//
// - Geofence: haversine distance from the outlet point (server side; raw
//   coordinates are never stored or returned, only the rounded distance).
// - Rotating QR: 30 s windows (`qrWindowOf`). Token v2 and its daily keys live
//   in hris-attendance-qr.ts (the current and previous window are accepted).
// - Work timing: late / early leave / overtime in whole minutes against the
//   assigned shift (first segment start .. last segment end).
// - Selfie retention: due once the payroll close time plus N days has passed.
// - Review sampling: deterministic from the log id so the queue stays stable.

import { createHash } from "node:crypto";
import {
  ATTENDANCE_QR_ROTATION_SECONDS,
  type ShiftAssignmentSegment,
} from "@starter/shared/hris";
import { localDateOf } from "@starter/shared/core";
import type { Geofence } from "@starter/shared/platform";

const EARTH_RADIUS_METERS = 6_371_008.8;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const QR_WINDOW_MS = ATTENDANCE_QR_ROTATION_SECONDS * 1_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two WGS84 points, in metres (unrounded). */
export function haversineMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface GeofenceDistance {
  /** Whole metres from the outlet point. */
  distanceMeters: number;
  /** True when the distance is within the outlet radius (edge inclusive). */
  withinRadius: boolean;
}

/**
 * Distance of a reported position from `outlets.geofence`. Null geofence (the
 * outlet has none configured) gives null: the caller decides how to treat it.
 */
export function geofenceDistance(
  position: { latitude: number; longitude: number },
  geofence: Geofence | null | undefined,
): GeofenceDistance | null {
  if (!geofence) return null;
  const meters = haversineMeters(position, geofence);
  return {
    distanceMeters: Math.round(meters),
    withinRadius: meters <= geofence.radiusMeters,
  };
}

/** Index of the 30 s window an instant (epoch ms) falls in. */
export function qrWindowOf(epochMs: number): number {
  return Math.floor(epochMs / QR_WINDOW_MS);
}

export interface WorkTimingInput {
  /** Published segments of the employee's shift on the business date. */
  segments: readonly ShiftAssignmentSegment[];
  clockInAt?: Date | null;
  clockOutAt?: Date | null;
  /** IANA zone of the outlet; used for the business date of the shift. */
  timeZone: string;
}

export interface WorkTiming {
  /** Local date of the shift start; null without a shift. */
  businessDate: string | null;
  /** Whole minutes in after the shift start; 0 when on time; null when unknown. */
  lateMinutes: number | null;
  /** Whole minutes out before the shift end; 0 when not early; null when unknown. */
  earlyLeaveMinutes: number | null;
  /** Whole minutes out after the shift end; 0 when none; null when unknown. */
  overtimeMinutes: number | null;
}

function wholeMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / MS_PER_MINUTE));
}

/**
 * Late / early leave / overtime against the assigned shift. The shift spans
 * the earliest segment start to the latest segment end (a split shift is
 * measured on its outer edges). Without a shift, or without the matching
 * clock event, the minutes are null (PRD: "Tanpa shift: late/OT null").
 */
export function computeWorkTiming(input: WorkTimingInput): WorkTiming {
  if (input.segments.length === 0)
    return {
      businessDate: null,
      lateMinutes: null,
      earlyLeaveMinutes: null,
      overtimeMinutes: null,
    };
  const starts = input.segments.map((s) => Date.parse(s.startsAt));
  const ends = input.segments.map((s) => Date.parse(s.endsAt));
  const shiftStart = Math.min(...starts);
  const shiftEnd = Math.max(...ends);
  const clockIn = input.clockInAt?.getTime();
  const clockOut = input.clockOutAt?.getTime();
  return {
    businessDate: localDateOf(new Date(shiftStart), input.timeZone),
    lateMinutes:
      clockIn === undefined ? null : wholeMinutes(clockIn - shiftStart),
    earlyLeaveMinutes:
      clockOut === undefined ? null : wholeMinutes(shiftEnd - clockOut),
    overtimeMinutes:
      clockOut === undefined ? null : wholeMinutes(clockOut - shiftEnd),
  };
}

/**
 * True when the selfie of a log must be purged: the payroll run covering its
 * business date closed at `lockedAt` and `retentionDays` have passed. No
 * closed payroll (null) means the photo is kept.
 */
export function selfieRetentionDue(
  lockedAt: Date | null | undefined,
  retentionDays: number,
  now: Date,
): boolean {
  if (!lockedAt) return false;
  return lockedAt.getTime() + retentionDays * MS_PER_DAY <= now.getTime();
}

/**
 * Deterministic random sample for the review queue: the first 32 bits of
 * sha256(logId) as a fraction in [0, 1) compared with `rate`. The same log
 * always gives the same answer for the same rate; rate <= 0 selects none,
 * rate >= 1 selects all.
 */
export function sampleSelected(logId: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  const fraction =
    createHash("sha256").update(logId).digest().readUInt32BE(0) / 2 ** 32;
  return fraction < rate;
}
