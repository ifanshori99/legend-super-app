// Customer display domain helpers (bead legend-azt). PRD v1.7 §3 F11
// "POS Kasir & Captain Order" — Customer Display (items, total, QRIS) — and
// §3 F13 "QRIS Dinamis" (the code is refreshed when it expires). The screen
// itself runs in e2e/legend-azt.mock.spec.ts against the mock runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as pos from "../packages/shared/src/pos/index.ts";
import { isMessageKey } from "../packages/shared/src/i18n/index.ts";
import {
  DISPLAY_MIN_REFETCH_MS,
  DISPLAY_POLL_MS,
  TENDER_LABEL,
  displayRefetchMs,
  formatCountdown,
  isQrisExpired,
  secondsUntilExpiry,
  totalQuantity,
} from "../apps/web/src/features/ws04-display/lib.ts";

const fixtures = pos.cafeLegendPosFixtures;
const display = pos.posFixtureSchema.parse(fixtures).customerDisplayState;
const NOW = Date.parse("2026-11-01T03:40:00.000Z");

const qris = (expiresInMs) => ({
  provider: "doit",
  amountIdr: display.totalIdr,
  payload: "00020101021226660014ID.CO.DOIT.WWW",
  expiresAt: new Date(NOW + expiresInMs).toISOString(),
});

test("PRD §3 F11 customer display: fixtures pair a display and show the bill total", () => {
  // The display snapshot belongs to the paired terminal and display, and its
  // total is exactly subtotal − discount + service + tax + rounding.
  assert.ok(display.terminalDeviceId);
  assert.ok(display.displayDeviceId);
  assert.equal(
    display.totalIdr,
    display.subtotalIdr -
      display.discountIdr +
      display.serviceChargeIdr +
      display.taxIdr +
      display.roundingIdr,
  );
  assert.ok(display.tenders.length > 0, "a paid bill shows how it was paid");
});

test("PRD §3 F11/F13: the display reads again before the QRIS expires", () => {
  // Normal poll while no code is payable.
  assert.equal(displayRefetchMs(null, NOW), DISPLAY_POLL_MS);
  assert.equal(
    displayRefetchMs({ state: "ordering", qris: null }, NOW),
    DISPLAY_POLL_MS,
  );
  // The code expires in 3 seconds: read again then, not 5 seconds later.
  assert.equal(
    displayRefetchMs(
      { state: "awaiting_payment", qris: qris(3_000) },
      NOW,
    ),
    3_000,
  );
  // A long-lived code keeps the normal poll interval.
  assert.equal(
    displayRefetchMs(
      { state: "awaiting_payment", qris: qris(10 * 60_000) },
      NOW,
    ),
    DISPLAY_POLL_MS,
  );
  // An already-expired code retries within a second (never a dead code stays).
  assert.equal(
    displayRefetchMs(
      { state: "awaiting_payment", qris: qris(-1_000) },
      NOW,
    ),
    DISPLAY_MIN_REFETCH_MS,
  );
});

test("PRD §3 F11/F13: expiry and countdown are exact and never negative", () => {
  assert.equal(secondsUntilExpiry(qris(3_000).expiresAt, NOW), 3);
  assert.equal(isQrisExpired(qris(3_000), NOW), false);
  assert.equal(isQrisExpired(qris(0), NOW), true);
  assert.equal(isQrisExpired(qris(-5_000), NOW), true);
  // 9:58 under a ten-minute DOIT code, and a floored, clamped display.
  assert.equal(formatCountdown(598), "9:58");
  assert.equal(formatCountdown(61), "1:01");
  assert.equal(formatCountdown(5), "0:05");
  assert.equal(formatCountdown(-5), "0:00");
});

test("PRD §3 F11: every POS tender method has a catalog label", () => {
  for (const method of pos.POS_TENDER_METHODS) {
    const key = TENDER_LABEL[method];
    assert.ok(key, `${method} has a label`);
    assert.ok(isMessageKey(key), `${key} is a catalog key`);
  }
});

test("PRD §3 F11: the quantity badge counts every portion on the bill", () => {
  assert.equal(totalQuantity(display.lines), 4);
  assert.equal(totalQuantity([]), 0);
});
