// Rotating attendance QR, token v2 with per-outlet daily keys (bead
// legend-cku1m, card C4; design docs/design/hris-edge-replication.md §4).
//
//   dayIndex(window) = floor(window * 30_000 / 86_400_000)      (UTC day)
//   dayKey           = HMAC-SHA256(seed, "legend/attendance-qr/v2|" + tenantId
//                                        + "|" + outletId + "|" + dayIndex)
//   token(window)    = "2." + base64url(HMAC-SHA256(dayKey, String(window)))
//
// The cloud derives day keys from the outlet seed (`seedQrKeySource`). The edge
// never holds a seed: it reads the day keys the cloud sent in the people
// snapshot (`edgeTableQrKeySource`, table `edge_attendance_qr_keys`, card C1).
// Verification accepts the current and the previous 30 s window, compared in
// constant time. There is no v1 fallback (no dual-algorithm period).
//
// Nothing here logs or returns a seed or a day key.
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { ATTENDANCE_QR_ROTATION_SECONDS } from "@starter/shared/hris";
import { HttpError } from "../lib/http-error.ts";
import { qrWindowOf } from "./hris-attendance-logic.ts";

const QR_WINDOW_MS = ATTENDANCE_QR_ROTATION_SECONDS * 1_000;
const MS_PER_DAY = 86_400_000;
const QR_KEY_DOMAIN = "legend/attendance-qr/v2";
export const QR_TOKEN_PREFIX = "2.";
/** Length of a day key in bytes (HMAC-SHA256 output). */
export const QR_DAY_KEY_BYTES = 32;

/**
 * Where day keys come from. `null` means "no key for that day": the display
 * answers 503 and a clock-in with a QR is rejected.
 */
export interface QrKeySource {
  dayKey(
    tenantId: string,
    outletId: string,
    dayIndex: number,
  ): Promise<Uint8Array | null>;
}

/** UTC day index of a 30 s window. */
export function qrDayIndexOfWindow(window: number): number {
  return Math.floor((window * QR_WINDOW_MS) / MS_PER_DAY);
}

export function deriveQrDayKey(
  seed: Uint8Array,
  tenantId: string,
  outletId: string,
  dayIndex: number,
): Buffer {
  return createHmac("sha256", seed)
    .update(`${QR_KEY_DOMAIN}|${tenantId}|${outletId}|${dayIndex}`)
    .digest();
}

/** Day keys of `count` consecutive days from `fromDay` (the cloud sends these to an edge). */
export function deriveQrDayKeys(
  seed: Uint8Array,
  tenantId: string,
  outletId: string,
  fromDay: number,
  count: number,
): { dayIndex: number; key: Buffer }[] {
  return Array.from({ length: count }, (_, offset) => {
    const dayIndex = fromDay + offset;
    return {
      dayIndex,
      key: deriveQrDayKey(seed, tenantId, outletId, dayIndex),
    };
  });
}

/** v2 token of one window under its day key. */
export function qrTokenForWindow(dayKey: Uint8Array, window: number): string {
  return `${QR_TOKEN_PREFIX}${createHmac("sha256", dayKey)
    .update(String(window))
    .digest("base64url")}`;
}

/** Cloud source: derives the day key from the outlet seed. */
export function seedQrKeySource(
  loadSeed: (tenantId: string, outletId: string) => Promise<Uint8Array | null>,
): QrKeySource {
  return {
    async dayKey(tenantId, outletId, dayIndex) {
      const seed = await loadSeed(tenantId, outletId);
      return seed ? deriveQrDayKey(seed, tenantId, outletId, dayIndex) : null;
    },
  };
}

/** Minimal query surface of a Drizzle transaction used by the edge source. */
export interface QrKeyQueryRunner {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/**
 * Edge source: reads `edge_attendance_qr_keys` (created by card C1,
 * legend-hwn02). Raw SQL so this card has no schema dependency; RLS limits the
 * rows to the tenant and outlet of the transaction.
 */
export function edgeTableQrKeySource(runner: QrKeyQueryRunner): QrKeySource {
  return {
    async dayKey(tenantId, outletId, dayIndex) {
      const result = (await runner.execute(
        sql`SELECT key FROM edge_attendance_qr_keys
             WHERE tenant_id = ${tenantId} AND outlet_id = ${outletId}
               AND day_index = ${dayIndex}
             LIMIT 1`,
      )) as { rows?: { key: Uint8Array }[] } | { key: Uint8Array }[];
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      const key = rows[0]?.key;
      return key && key.length === QR_DAY_KEY_BYTES ? key : null;
    },
  };
}

export function qrKeyUnavailable(): HttpError {
  return new HttpError(
    503,
    "QR_KEY_UNAVAILABLE",
    "The QR key for today is not available on this server. Use another clock-in method.",
  );
}

/** Token of the window containing `nowMs`; 503 `QR_KEY_UNAVAILABLE` without a key. */
export async function issueQrToken(
  source: QrKeySource,
  tenantId: string,
  outletId: string,
  nowMs: number,
): Promise<{ token: string; window: number }> {
  const window = qrWindowOf(nowMs);
  const dayKey = await source.dayKey(
    tenantId,
    outletId,
    qrDayIndexOfWindow(window),
  );
  if (!dayKey) throw qrKeyUnavailable();
  return { token: qrTokenForWindow(dayKey, window), window };
}

/**
 * True when `token` is the v2 token of the window containing `nowMs` or of the
 * window right before it (each under its own day key). Constant-time compare;
 * a missing key, a v1 token or any other shape is simply false.
 */
export async function validateQr(
  source: QrKeySource,
  tenantId: string,
  outletId: string,
  token: string,
  nowMs: number,
): Promise<boolean> {
  const given = Buffer.from(token);
  const current = qrWindowOf(nowMs);
  let matched = false;
  for (const window of [current, current - 1]) {
    const dayKey = await source.dayKey(
      tenantId,
      outletId,
      qrDayIndexOfWindow(window),
    );
    if (!dayKey) continue;
    const expected = Buffer.from(qrTokenForWindow(dayKey, window));
    if (expected.length === given.length && timingSafeEqual(expected, given))
      matched = true;
  }
  return matched;
}
