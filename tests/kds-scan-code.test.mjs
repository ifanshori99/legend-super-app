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
  { id: "t1", ticketNo: 1, status: "in_progress" },
  { id: "t2", ticketNo: 2, status: "new" },
  { id: "t3", ticketNo: 3, status: "done" },
  { id: "t4", ticketNo: 4, status: "cancelled" },
];

test("legend-tzyj2: the ticket code is the padded ticket number shown on the header", () => {
  assert.equal(ticketScanCode(tickets[0].ticketNo), "K-001");
  assert.equal(ticketScanCode(42), "K-042");
  assert.equal(ticketScanCode(1234), "K-1234");
});

test("legend-uqfu: parser trims, uppercases and maps the four action words", () => {
  assert.deepEqual(parseScanCode("  selesai  k-001 \n"), {
    ok: true,
    action: "bump",
    code: "K-001",
  });
  assert.equal(parseScanCode("MULAI #K-002").action, "start");
  assert.equal(parseScanCode("PRIORITAS K-002").action, "priority");
  assert.equal(parseScanCode("PANGGIL K-003").action, "recall");
});

test("legend-uqfu: parser refuses empty, malformed and unknown actions", () => {
  assert.deepEqual(parseScanCode("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseScanCode("SELESAI"), { ok: false, reason: "format" });
  assert.deepEqual(parseScanCode("SELESAI A B"), {
    ok: false,
    reason: "format",
  });
  assert.deepEqual(parseScanCode("HAPUS K-001"), {
    ok: false,
    reason: "unknown-action",
  });
  assert.deepEqual(parseScanCode("toString K-001"), {
    ok: false,
    reason: "unknown-action",
  });
});

test("legend-uqfu: a scan matches one ticket of the board", () => {
  const result = resolveScan("selesai k-001", tickets);
  assert.equal(result.ok, true);
  assert.equal(result.action, "bump");
  assert.equal(result.ticket.id, "t1");
  assert.equal(resolveScan("MULAI K-002", tickets).ticket.id, "t2");
  assert.equal(resolveScan("PANGGIL K-003", tickets).ticket.id, "t3");
});

test("legend-uqfu: unknown or ambiguous codes and invalid statuses are errors", () => {
  assert.equal(resolveScan("SELESAI K-999", tickets).reason, "unknown-ticket");
  assert.equal(resolveScan("SELESAI K-001", []).reason, "unknown-ticket");
  const twins = [
    { id: "a", ticketNo: 7, status: "new" },
    { id: "b", ticketNo: 7, status: "new" },
  ];
  assert.equal(resolveScan("MULAI K-007", twins).reason, "unknown-ticket");
  // start needs new/recalled, bump needs in_progress, recall needs done.
  assert.equal(resolveScan("SELESAI K-002", tickets).reason, "invalid-status");
  assert.equal(resolveScan("MULAI K-001", tickets).reason, "invalid-status");
  assert.equal(resolveScan("PANGGIL K-001", tickets).reason, "invalid-status");
  assert.equal(
    resolveScan("PRIORITAS K-004", tickets).reason,
    "invalid-status",
  );
  assert.equal(resolveScan("HAPUS K-001", tickets).reason, "unknown-action");
});

test("legend-uqfu: priority is allowed on every live ticket", () => {
  for (const status of ["new", "in_progress", "done", "recalled"])
    assert.equal(canScanAction(status, "priority"), true, status);
  assert.equal(canScanAction("cancelled", "priority"), false);
});

test("legend-uqfu: invalid-status carries the ticket, open and scannable follow the status", () => {
  const refused = resolveScan("SELESAI K-002", tickets);
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
