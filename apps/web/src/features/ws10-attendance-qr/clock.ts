// Clock-skew estimate for the outlet QR display (F25).
//
// An outlet screen is often a cheap tablet whose clock drifts, while the token
// window (`issuedAt`..`expiresAt`) comes from the server clock. Comparing the
// two directly would let a display whose clock is behind keep showing a token
// the server already rotated away, and one whose clock is ahead flash
// "expired" forever while polling every second.
//
// Every response bounds the server-minus-device offset: the server answered
// after the request left (`sentAt`) and before it arrived (`receivedAt`), and
// at that moment it was inside the token's window. So
//   issuedAt - receivedAt  <=  offset  <=  expiresAt - sentAt.
// Bounds from successive responses are intersected, so they tighten every time
// a poll lands on either side of a rotation. The device clock is trusted while
// it is consistent with the bounds (offset 0); otherwise the estimate snaps to
// the nearest bound. A contradiction (the device clock jumped) resets them.
import type { AttendanceQrToken } from "@starter/shared/hris";

export type ClockBounds = { readonly lo: number; readonly hi: number };

/** Until the bounds are this tight, the display polls on a short cadence. */
export const CONVERGED_WIDTH_MS = 6_000;

export function nextClockBounds(
  previous: ClockBounds | null,
  qr: Pick<AttendanceQrToken, "issuedAt" | "expiresAt">,
  sentAt: number,
  receivedAt: number,
): ClockBounds {
  const fresh: ClockBounds = {
    lo: Date.parse(qr.issuedAt) - receivedAt,
    hi: Date.parse(qr.expiresAt) - sentAt,
  };
  if (!previous) return fresh;
  const lo = Math.max(previous.lo, fresh.lo);
  const hi = Math.min(previous.hi, fresh.hi);
  return lo <= hi ? { lo, hi } : fresh;
}

/** Server time minus device time, in ms. */
export function estimateOffset(bounds: ClockBounds): number {
  return Math.min(bounds.hi, Math.max(bounds.lo, 0));
}
