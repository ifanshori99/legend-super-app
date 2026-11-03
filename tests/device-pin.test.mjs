// Device PIN pad + override modal rules (bead legend-6ew). Cites PRD v1.7 §3 F6
// "PIN Perangkat" (6 digits, locked after 5 wrong), §3.6 "Override
// Supervisor" and AUTH-06 (requester, approver, reason and value recorded).
import assert from "node:assert/strict";
import { test } from "node:test";

import * as identity from "../packages/shared/src/identity/index.ts";
import * as logic from "../apps/web/src/features/ws01-device-pin/logic.ts";

test("AUTH-06 · the pad takes at most the contract's PIN length, digits only", () => {
  let pin = "";
  for (const key of "12a3456789")
    pin = logic.appendDigit(pin, key, identity.STAFF_PIN_LENGTH);
  assert.equal(pin, "123456");
  assert.equal(logic.removeLastDigit(pin), "12345");
});

test("AUTH-06 · lockout countdown follows the contract lock window", () => {
  const now = Date.parse("2026-11-03T10:00:00.000Z");
  const locked = identity.recordStaffPinAttempt({
    state: {
      failedAttempts: identity.MAX_STAFF_PIN_ATTEMPTS - 1,
      lockedUntil: null,
    },
    correct: false,
    now: new Date(now),
  });
  const left = logic.lockRemainingMs(locked.lockedUntil, now);
  assert.equal(left, identity.STAFF_PIN_LOCK_MINUTES * identity.MINUTE_MS);
  assert.equal(logic.formatCountdown(left), "15:00");
  assert.equal(logic.formatCountdown(1), "00:01");
  assert.equal(logic.lockRemainingMs(locked.lockedUntil, now + left), 0);
  assert.equal(logic.attemptsRemaining(2, identity.MAX_STAFF_PIN_ATTEMPTS), 3);
});

test("AUTH-06 · override form needs value, reason code and a 3+ char reason", () => {
  assert.deepEqual(
    logic.validateOverrideForm({ valueText: "", reasonCode: "", reason: "ab" }),
    { value: true, reasonCode: true, reason: true },
  );
  assert.deepEqual(
    logic.validateOverrideForm({
      valueText: "350.000",
      reasonCode: "customer_cancel",
      reason: "Pelanggan batal",
    }),
    {},
  );
  assert.equal(logic.parseRupiah("1.250.000"), 1_250_000);
  assert.equal(logic.parseRupiah("-5"), null);
});

test("AUTH-06 · phone approval outcome: pending, decided, or expired past the deadline", () => {
  const deadlineAt = "2026-11-03T11:00:00.000Z";
  const before = Date.parse("2026-11-03T10:30:00.000Z");
  const after = Date.parse("2026-11-03T11:00:00.000Z");
  assert.equal(
    logic.approvalOutcome({ status: "pending", deadlineAt }, before),
    "pending",
  );
  assert.equal(
    logic.approvalOutcome({ status: "pending", deadlineAt }, after),
    "expired",
  );
  assert.equal(
    logic.approvalOutcome({ status: "approved", deadlineAt }, after),
    "approved",
  );
  assert.equal(
    logic.approvalOutcome({ status: "rejected", deadlineAt }, before),
    "rejected",
  );
});
