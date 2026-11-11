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

// Regression for legend-6ew "typing the final PIN digit fails": a model of the
// pad's entry loop built from the same pure rules the component uses. Keys
// (keyboard or on-screen) append; a full PIN is handed over only when nothing
// is being checked, and the pad empties itself on hand-over.
function padModel() {
  const length = identity.STAFF_PIN_LENGTH;
  const state = { pin: "", pending: false, sent: [] };
  const flush = () => {
    if (logic.readyToHandOver(state.pin, state.pending, length)) {
      state.sent.push(state.pin);
      state.pin = "";
      state.pending = true;
    }
  };
  return {
    state,
    key(digit) {
      state.pin = logic.appendDigit(state.pin, digit, length);
      flush();
    },
    answer() {
      state.pending = false;
      flush();
    },
    dots: () => logic.pinPadDots(state.pin.length, state.pending, length),
  };
}

for (const via of ["keyboard", "on-screen pad"]) {
  test(`AUTH-06 · regression (${via}): the sixth digit submits even when typed during the previous check`, () => {
    const pad = padModel();
    for (const digit of "111222") pad.key(digit);
    assert.deepEqual(pad.state.sent, ["111222"]);
    assert.equal(
      pad.dots(),
      identity.STAFF_PIN_LENGTH,
      "all dots while checking",
    );
    // The next PIN is typed before the first answer arrives.
    for (const digit of "246810") pad.key(digit);
    assert.equal(pad.state.pin, "246810", "no digit dropped while checking");
    assert.deepEqual(pad.state.sent, ["111222"], "never two checks at once");
    pad.answer(); // wrong PIN answered: the waiting PIN goes out at once
    assert.deepEqual(pad.state.sent, ["111222", "246810"]);
    assert.equal(pad.state.pin, "", "the PIN is not kept after hand-over");
  });
}

test("AUTH-06 · a full PIN waits while checking and the pad shows typed digits", () => {
  assert.equal(logic.readyToHandOver("246810", true, 6), false);
  assert.equal(logic.readyToHandOver("24681", false, 6), false);
  assert.equal(logic.readyToHandOver("246810", false, 6), true);
  assert.equal(logic.pinPadDots(0, true, 6), 6);
  assert.equal(logic.pinPadDots(2, true, 6), 2);
  assert.equal(logic.pinPadDots(0, false, 6), 0);
});

// legend-6ew E4: an active staff entry saved before the outlet was stored has
// no outletId. The device's own outlet stands in; with neither, the caller must
// ask for a PIN sign-in again instead of showing a generic failure.
test("AUTH-06 · override outlet: saved entry wins, then the device outlet, else none", async () => {
  const { resolveOverrideOutlet } =
    await import("../apps/web/src/features/ws01-device-pin/override-outlet.ts");
  assert.equal(
    resolveOverrideOutlet("outlet-saved", "outlet-device"),
    "outlet-saved",
  );
  assert.equal(
    resolveOverrideOutlet(undefined, "outlet-device"),
    "outlet-device",
  );
  assert.equal(resolveOverrideOutlet("", "outlet-device"), "outlet-device");
  assert.equal(resolveOverrideOutlet("  ", "outlet-device"), "outlet-device");
  assert.equal(resolveOverrideOutlet(undefined, undefined), null);
  assert.equal(resolveOverrideOutlet(null, ""), null);
});

// legend-495 G4: one Idempotency-Key per override intent. A retry of the same
// form (same fields, same method and approver) re-sends the same key; the key
// changes only when the form changes or after the intent is finished.
test("AUTH-06 · override intent: one idempotency key per intent, reused on retry", () => {
  let made = 0;
  const keeper = logic.createIntentKeyKeeper(() => `key-${++made}`);
  const form = {
    outletId: "o1",
    action: "void_item",
    objectType: "order",
    objectId: "ord-1",
    valueText: "350000",
    reasonCode: "out_of_stock",
    reason: " Bahan habis ",
    method: "pin",
    approverId: "u-sup",
  };
  const first = keeper.keyFor(logic.overrideIntentSignature(form));
  const retry = keeper.keyFor(logic.overrideIntentSignature(form));
  assert.equal(retry, first);
  // Surrounding spaces in the reason do not make a new intent (trimmed on send).
  assert.equal(
    keeper.keyFor(
      logic.overrideIntentSignature({ ...form, reason: "Bahan habis" }),
    ),
    first,
  );
  // A changed field is a new intent.
  const changed = keeper.keyFor(
    logic.overrideIntentSignature({ ...form, valueText: "400000" }),
  );
  assert.notEqual(changed, first);
  assert.notEqual(
    keeper.keyFor(
      logic.overrideIntentSignature({
        ...form,
        valueText: "400000",
        approverId: "u-2",
      }),
    ),
    changed,
  );
  // After the intent finishes, the same form is a new intent.
  const before = keeper.keyFor(logic.overrideIntentSignature(form));
  keeper.reset();
  assert.notEqual(keeper.keyFor(logic.overrideIntentSignature(form)), before);
});

// legend-495 G3: a phone approval is final only when the override itself is
// settled as approved; the request alone (status approved) is not enough.
test("AUTH-06 · phone outcome follows the settled override, not the request alone", () => {
  const approvedRequest = { raw: "approved", decidedBy: "u-sup" };
  const out = (settled, request = approvedRequest) =>
    logic.phoneOutcome({ ...request, settled, requesterId: "u-cashier" });
  // Request approved, settlement unknown or pending: keep waiting.
  assert.deepEqual(out(null), { outcome: "pending", selfApproved: false });
  assert.deepEqual(out({ status: "pending", approvedBy: null }), {
    outcome: "pending",
    selfApproved: false,
  });
  // Settled approved by another person: approved.
  assert.deepEqual(out({ status: "approved", approvedBy: "u-sup" }), {
    outcome: "approved",
    selfApproved: false,
  });
  // Settled as anything else: shown as that end, never approved.
  assert.equal(
    out({ status: "rejected", approvedBy: null }).outcome,
    "rejected",
  );
  assert.equal(
    out({ status: "cancelled", approvedBy: null }).outcome,
    "cancelled",
  );
  assert.equal(out({ status: "expired", approvedBy: null }).outcome, "expired");
  // AUTH-06: approver missing or the requester: rejected, flagged.
  assert.deepEqual(out({ status: "approved", approvedBy: "u-cashier" }), {
    outcome: "rejected",
    selfApproved: true,
  });
  assert.deepEqual(out(null, { raw: "approved", decidedBy: "u-cashier" }), {
    outcome: "rejected",
    selfApproved: true,
  });
  // A request that did not end approved needs no settlement.
  for (const raw of ["pending", "rejected", "cancelled", "expired"])
    assert.deepEqual(out(null, { raw, decidedBy: null }), {
      outcome: raw,
      selfApproved: false,
    });
});

// legend-495 G5: closing a pending wait (X, Escape, outside click) cancels first.
test("AUTH-06 · closing a pending wait is a cancel, not a plain close", () => {
  assert.equal(
    logic.closeAction({ waiting: true, outcome: "pending" }),
    "cancel",
  );
  assert.equal(
    logic.closeAction({ waiting: true, outcome: "approved" }),
    "close",
  );
  assert.equal(
    logic.closeAction({ waiting: true, outcome: "rejected" }),
    "close",
  );
  assert.equal(
    logic.closeAction({ waiting: false, outcome: "pending" }),
    "close",
  );
});

// legend-495 H2: closing while the phone request is being created, or after a
// network error (it may exist on the server), must not leave an orphan.
test("AUTH-06 · closing the form during or after a send is held or recovered", () => {
  assert.equal(
    logic.formCloseAction({ sending: true, uncertain: false }),
    "hold",
  );
  assert.equal(
    logic.formCloseAction({ sending: true, uncertain: true }),
    "hold",
  );
  assert.equal(
    logic.formCloseAction({ sending: false, uncertain: true }),
    "recover",
  );
  assert.equal(
    logic.formCloseAction({ sending: false, uncertain: false }),
    "close",
  );
});

test("AUTH-06 · approved request not yet settled is a wait for settlement", () => {
  assert.equal(
    logic.awaitingSettlement({ raw: "approved", outcome: "pending" }),
    true,
  );
  assert.equal(
    logic.awaitingSettlement({ raw: "pending", outcome: "pending" }),
    false,
  );
  assert.equal(
    logic.awaitingSettlement({ raw: "approved", outcome: "approved" }),
    false,
  );
  assert.equal(
    logic.awaitingSettlement({ raw: "approved", outcome: "rejected" }),
    false,
  );
});
