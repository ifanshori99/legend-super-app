// KDS scanner codes (bead legend-uqfu): `<AKSI> <TIKET>` parsing and the match
// to one ticket of the current station board.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canScanAction,
  exampleScanTicket,
  hasScannableTicket,
  isOpenTicket,
  parseScanCode,
  resolveScan,
  ticketScanCode,
} from "../apps/web/src/features/ws04-kds/scan-code.ts";

const tickets = [
  { id: "t1", orderId: "01JBQ7Z8K3M4N5P6Q7R8S9T0V1", status: "in_progress" },
  { id: "t2", orderId: "01JBQ7Z8K3M4N5P6Q7R8S9T0V2", status: "new" },
  { id: "t3", orderId: "01JBQ7Z8K3M4N5P6Q7R8S9T0V3", status: "done" },
  { id: "t4", orderId: "01JBQ7Z8K3M4N5P6Q7R8S9T0V4", status: "cancelled" },
];

test("legend-uqfu: the ticket code is the tail shown on the ticket header", () => {
  assert.equal(ticketScanCode(tickets[0].orderId), "S9T0V1");
});

test("legend-uqfu: parser trims, uppercases and maps the four action words", () => {
  assert.deepEqual(parseScanCode("  selesai  s9t0v1 \n"), {
    ok: true,
    action: "bump",
    code: "S9T0V1",
  });
  assert.equal(parseScanCode("MULAI #S9T0V2").action, "start");
  assert.equal(parseScanCode("PRIORITAS S9T0V2").action, "priority");
  assert.equal(parseScanCode("PANGGIL S9T0V3").action, "recall");
});

test("legend-uqfu: parser refuses empty, malformed and unknown actions", () => {
  assert.deepEqual(parseScanCode("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseScanCode("SELESAI"), { ok: false, reason: "format" });
  assert.deepEqual(parseScanCode("SELESAI A B"), {
    ok: false,
    reason: "format",
  });
  assert.deepEqual(parseScanCode("HAPUS S9T0V1"), {
    ok: false,
    reason: "unknown-action",
  });
  assert.deepEqual(parseScanCode("toString S9T0V1"), {
    ok: false,
    reason: "unknown-action",
  });
});

test("legend-uqfu: a scan matches one ticket of the board", () => {
  const result = resolveScan("selesai s9t0v1", tickets);
  assert.equal(result.ok, true);
  assert.equal(result.action, "bump");
  assert.equal(result.ticket.id, "t1");
  assert.equal(resolveScan("MULAI S9T0V2", tickets).ticket.id, "t2");
  assert.equal(resolveScan("PANGGIL S9T0V3", tickets).ticket.id, "t3");
});

test("legend-uqfu: unknown or ambiguous codes and invalid statuses are errors", () => {
  assert.equal(resolveScan("SELESAI ZZZZZZ", tickets).reason, "unknown-ticket");
  assert.equal(resolveScan("SELESAI S9T0V1", []).reason, "unknown-ticket");
  const twins = [
    { id: "a", orderId: "X-AAAAAA", status: "new" },
    { id: "b", orderId: "Y-AAAAAA", status: "new" },
  ];
  assert.equal(resolveScan("MULAI AAAAAA", twins).reason, "unknown-ticket");
  // start needs new/recalled, bump needs in_progress, recall needs done.
  assert.equal(resolveScan("SELESAI S9T0V2", tickets).reason, "invalid-status");
  assert.equal(resolveScan("MULAI S9T0V1", tickets).reason, "invalid-status");
  assert.equal(resolveScan("PANGGIL S9T0V1", tickets).reason, "invalid-status");
  assert.equal(
    resolveScan("PRIORITAS S9T0V4", tickets).reason,
    "invalid-status",
  );
  assert.equal(resolveScan("HAPUS S9T0V1", tickets).reason, "unknown-action");
});

test("legend-uqfu: priority is allowed on every live ticket", () => {
  for (const status of ["new", "in_progress", "done", "recalled"])
    assert.equal(canScanAction(status, "priority"), true, status);
  assert.equal(canScanAction("cancelled", "priority"), false);
});

test("legend-uqfu: invalid-status carries the ticket, open and scannable follow the status", () => {
  const refused = resolveScan("SELESAI S9T0V2", tickets);
  assert.equal(refused.reason, "invalid-status");
  assert.equal(refused.ticket.id, "t2");
  assert.equal(isOpenTicket({ status: "new" }), true);
  assert.equal(isOpenTicket({ status: "done" }), false);
  assert.equal(isOpenTicket({ status: "cancelled" }), false);
  assert.equal(hasScannableTicket([]), false);
  assert.equal(hasScannableTicket([{ status: "cancelled" }]), false);
  assert.equal(hasScannableTicket([{ status: "done" }]), true);
  assert.equal(exampleScanTicket(tickets).id, "t1");
  assert.equal(exampleScanTicket([tickets[1], tickets[2]]), undefined);
});
