// C2b (legend-osqou.4): the single Duitku return page `/bayar/kembali`.
// Duitku sends the guest back with `merchantOrderId`, `resultCode` and
// `reference` on the URL. Only the server's answer may settle the screen:
// `resultCode` is never an input, and without an answer the page keeps
// "Memeriksa". Pure module, loaded with Node type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LONG_WAIT_MS,
  RETURN_RECORD_TTL_MS,
  nextPollDelayMs,
  parseReturnRecord,
  pickReturnRecord,
  returnPhase,
  serializeReturnRecord,
  shouldPollReturn,
} from "../apps/web/src/features/ws05-payment/return-status.ts";

const paymentId = "0b1d7f0e-4a52-4c8e-9a43-2f5b7c1d9e10";
const now = Date.parse("2026-11-27T07:32:00.000Z");

const tableRecord = {
  v: 1,
  kind: "table",
  paymentId,
  qrToken: `v1.${"C".repeat(40)}.${"D".repeat(43)}`,
  sessionId: "7f8e1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  orderId: "01JD5Z8Q4N7K2M3P4R5S6T7V8W",
  orderNumber: "QR-0044",
  tableCode: "A01",
  method: "ewallet",
  channelCode: "DA",
  channelName: "DANA",
  amountIdr: 26600,
  placeName: "Cafe Legend",
  savedAt: now - 30_000,
};

const linkRecord = {
  v: 1,
  kind: "link",
  paymentId,
  linkToken: "pl_abc123",
  method: "card",
  channelCode: null,
  channelName: null,
  amountIdr: 150000,
  placeName: "Cafe Legend",
  savedAt: now - 30_000,
};

const read = (records) => (id) =>
  records[id] === undefined ? null : serializeReturnRecord(records[id]);

test("C2b a stored record round-trips; a broken or foreign one reads as none", () => {
  assert.deepEqual(
    parseReturnRecord(serializeReturnRecord(tableRecord), now),
    tableRecord,
  );
  assert.deepEqual(
    parseReturnRecord(serializeReturnRecord(linkRecord), now),
    linkRecord,
  );
  assert.equal(parseReturnRecord(null, now), null);
  assert.equal(parseReturnRecord("{", now), null);
  assert.equal(
    parseReturnRecord(JSON.stringify({ ...tableRecord, v: 2 }), now),
    null,
  );
  assert.equal(
    parseReturnRecord(JSON.stringify({ ...tableRecord, sessionId: 1 }), now),
    null,
  );
  assert.equal(
    parseReturnRecord(JSON.stringify({ ...tableRecord, paymentId: "x" }), now),
    null,
  );
  // Old records are dropped, so a stale tab never shows someone's old order.
  assert.equal(
    parseReturnRecord(
      serializeReturnRecord({
        ...tableRecord,
        savedAt: now - RETURN_RECORD_TTL_MS - 1,
      }),
      now,
    ),
    null,
  );
});

test("C2b the record is found by Duitku's merchantOrderId, else the last one; resultCode is ignored", () => {
  const records = { [paymentId]: tableRecord };
  const pick = (search, last = paymentId) =>
    pickReturnRecord(new URLSearchParams(search), read(records), last, now);

  assert.deepEqual(
    pick(`merchantOrderId=${paymentId}&resultCode=00&reference=R1`),
    tableRecord,
  );
  // resultCode never changes which payment is read, nor whether one is.
  assert.deepEqual(
    pick(`merchantOrderId=${paymentId}&resultCode=01`),
    pick(`merchantOrderId=${paymentId}&resultCode=00`),
  );
  // No id on the URL: the payment this tab last sent to Duitku.
  assert.deepEqual(pick(""), tableRecord);
  assert.equal(pick("", null), null);
  // An id this browser never sent away is not guessed from the last one.
  assert.equal(
    pick("merchantOrderId=11111111-1111-4111-8111-111111111111"),
    null,
  );
  assert.equal(pick("merchantOrderId=not-a-uuid"), null);
});

test("C2b the phase comes only from the server answer (fail-first)", () => {
  const phase = (input) =>
    returnPhase({
      hasRecord: true,
      status: undefined,
      errorStatus: undefined,
      waitedMs: 0,
      ...input,
    });

  // No record in this browser: the link is not recognised.
  assert.equal(phase({ hasRecord: false }), "invalid");
  // Still reading storage (first render, server render): checking.
  assert.equal(phase({ hasRecord: undefined }), "checking");
  // No answer yet, or the network failed: keep checking, never guess.
  assert.equal(phase({}), "checking");
  assert.equal(phase({ errorStatus: null }), "checking");
  assert.equal(phase({ errorStatus: 503 }), "checking");
  assert.equal(
    phase({ errorStatus: 503, waitedMs: LONG_WAIT_MS * 3 }),
    "checking",
  );
  // The server does not know this payment for this guest.
  for (const code of [400, 401, 403, 404, 422])
    assert.equal(phase({ errorStatus: code }), "invalid", String(code));

  assert.equal(phase({ status: "pending" }), "waiting");
  assert.equal(
    phase({ status: "pending", waitedMs: LONG_WAIT_MS - 1 }),
    "waiting",
  );
  assert.equal(phase({ status: "pending", waitedMs: LONG_WAIT_MS }), "slow");
  for (const status of ["paid", "partially_refunded", "refunded"])
    assert.equal(phase({ status }), "paid", status);
  assert.equal(phase({ status: "failed" }), "failed");
  assert.equal(phase({ status: "expired" }), "expired");
  // A known answer wins over a later failed poll.
  assert.equal(phase({ status: "pending", errorStatus: 503 }), "waiting");
  assert.equal(phase({ status: "paid", errorStatus: 404 }), "paid");
});

test("C2b polling backs off and stops once the server's status is final", () => {
  const delays = Array.from({ length: 12 }, (_, attempt) =>
    nextPollDelayMs(attempt),
  );
  assert.equal(delays[0], 2000);
  for (let index = 1; index < delays.length; index += 1)
    assert.ok(delays[index] >= delays[index - 1], `attempt ${index}`);
  assert.equal(Math.max(...delays), 15_000);

  assert.equal(shouldPollReturn(undefined), true);
  assert.equal(shouldPollReturn("pending"), true);
  for (const status of [
    "paid",
    "failed",
    "expired",
    "refunded",
    "partially_refunded",
  ])
    assert.equal(shouldPollReturn(status), false, status);
});
