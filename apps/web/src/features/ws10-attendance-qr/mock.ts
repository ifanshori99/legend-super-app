// Mock handler for the rotating outlet QR (F25/F27). Registers ONLY
// `getAttendanceQr`; the review screen's log read is owned by the shared
// `lib/mock/handlers/hris-directory.ts` (one owner per endpoint).
//
// Like the employee PWA's scan fallback, the mock mints the token from the 30
// second clock slot instead of a database row, so the display really rotates
// when the browser clock crosses a window. The prefix matches that fallback
// (`features/ws10-hris-employee/mock.ts`), so one mock screen's code is also
// the code the other screen expects.
import {
  getAttendanceQr,
  ATTENDANCE_QR_ROTATION_SECONDS,
} from "@starter/shared/hris";
import { ApiError } from "../../lib/api/errors.ts";
import { MOCK_OUTLET } from "../../lib/mock/handlers/hris-directory.ts";
import { registerMock } from "../../lib/mock/registry.ts";

const QR_ROTATION_MS = ATTENDANCE_QR_ROTATION_SECONDS * 1_000;
const TOKEN_PREFIX = `QR-${MOCK_OUTLET.code.replace("-", "")}-OUTLET-`;

/** The token the outlet screen would show at `nowMs` (30-second slot). */
export function qrTokenAt(nowMs: number = Date.now()): string {
  const slot = Math.floor(nowMs / QR_ROTATION_MS)
    .toString(36)
    .toUpperCase()
    .padStart(6, "0");
  return `${TOKEN_PREFIX}${slot}`;
}

registerMock(getAttendanceQr, ({ query }) => {
  if (query.outletId !== MOCK_OUTLET.id)
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  const now = Date.now();
  const issuedMs = Math.floor(now / QR_ROTATION_MS) * QR_ROTATION_MS;
  // The response literal: the contract pins rotationSeconds to exactly 30.
  const rotationSeconds: 30 = ATTENDANCE_QR_ROTATION_SECONDS;
  return {
    data: {
      outletId: query.outletId,
      token: qrTokenAt(now),
      issuedAt: new Date(issuedMs).toISOString(),
      expiresAt: new Date(issuedMs + QR_ROTATION_MS).toISOString(),
      serverTime: new Date(now).toISOString(),
      rotationSeconds,
    },
  };
});
