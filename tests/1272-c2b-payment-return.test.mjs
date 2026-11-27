// C2b (legend-osqou.4): the single Duitku return page `/bayar/kembali`.
// Duitku sends the guest back with `merchantOrderId`, `resultCode` and
// `reference` on the URL. Only the server's answer may settle the screen:
// `resultCode` is never an input, and without an answer the page keeps
// "Memeriksa". Pure module, loaded with Node type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LATE_POLL_MS,
  LATE_WATCH_MS,
  LONG_WAIT_MS,
  RETURN_RECORD_TTL_MS,
  canStartNewPayment,
  isDuitkuPageHost,
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
  timeZone: "Asia/Makassar",
  theme: {
    tokens: { light: { brand: "#1d4ed8" } },
    fontFamily: "inter",
    corners: "lembut",
    logoUrl: null,
  },
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
  timeZone: null,
  theme: null,
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
      recordKind: "table",
      status: undefined,
      errorStatus: undefined,
      waitedMs: 0,
      ...input,
    });

  // No record in this browser: the link is not recognised.
  assert.equal(phase({ hasRecord: false }), "invalid");
  // Still reading storage (first render, server render): checking.
  assert.equal(phase({ hasRecord: undefined }), "checking");
  // No answer yet: keep checking, never guess.
  assert.equal(phase({}), "checking");
  assert.equal(phase({ waitedMs: LONG_WAIT_MS - 1 }), "checking");
  // Review P1 (UI audit): a payment that cannot be reached must not spin
  // forever. A network failure or 5xx, or a long wait with no answer at all,
  // shows "unreachable" (check again, do not pay again).
  assert.equal(phase({ errorStatus: null }), "unreachable");
  assert.equal(phase({ errorStatus: 500 }), "unreachable");
  assert.equal(phase({ errorStatus: 503 }), "unreachable");
  assert.equal(phase({ waitedMs: LONG_WAIT_MS }), "unreachable");
  assert.equal(
    phase({ errorStatus: 503, waitedMs: LONG_WAIT_MS * 3 }),
    "unreachable",
  );
  // The server does not know this payment for this guest.
  for (const code of [400, 404, 422])
    assert.equal(phase({ errorStatus: code }), "invalid", String(code));
  // Review P2-1: a table guest in a new tab has no session credential (401 or
  // 403); the order may well be paid, so point at the order status instead.
  for (const code of [401, 403]) {
    assert.equal(phase({ errorStatus: code }), "orders", String(code));
    assert.equal(
      phase({ errorStatus: code, recordKind: "link" }),
      "invalid",
      `link ${code}`,
    );
  }

  assert.equal(phase({ status: "pending" }), "waiting");
  assert.equal(
    phase({ status: "pending", waitedMs: LONG_WAIT_MS - 1 }),
    "waiting",
  );
  assert.equal(phase({ status: "pending", waitedMs: LONG_WAIT_MS }), "slow");
  assert.equal(phase({ status: "paid" }), "paid");
  // Review P3-3: a refund is not "lunas".
  for (const status of ["partially_refunded", "refunded"])
    assert.equal(phase({ status }), "refunded", status);
  assert.equal(phase({ status: "failed" }), "failed");
  assert.equal(phase({ status: "expired" }), "expired");
  // A known answer wins over a later failed poll.
  assert.equal(phase({ status: "pending", errorStatus: 503 }), "waiting");
  assert.equal(phase({ status: "paid", errorStatus: 404 }), "paid");
  assert.equal(phase({ status: "failed", errorStatus: 401 }), "failed");
});

test("C2b polling backs off, and keeps a slow watch after failed or expired (fail-first)", () => {
  const delays = Array.from({ length: 12 }, (_, attempt) =>
    nextPollDelayMs(attempt),
  );
  assert.equal(delays[0], 2000);
  for (let index = 1; index < delays.length; index += 1)
    assert.ok(delays[index] >= delays[index - 1], `attempt ${index}`);
  assert.equal(Math.max(...delays), 15_000);

  assert.equal(shouldPollReturn(undefined, 0), true);
  assert.equal(shouldPollReturn("pending", 0), true);
  for (const status of ["paid", "refunded", "partially_refunded"])
    assert.equal(shouldPollReturn(status, 0), false, status);

  // Review P2-2: failed -> paid and expired -> paid are legal (a late payment
  // from the gateway). Keep a slow watch for about ten minutes, so a guest
  // never sees "Coba lagi" for a payment that is about to settle.
  assert.equal(LATE_POLL_MS, 15_000);
  assert.equal(LATE_WATCH_MS, 10 * 60_000);
  for (const status of ["failed", "expired"]) {
    assert.equal(shouldPollReturn(status, 0), true, status);
    assert.equal(shouldPollReturn(status, LATE_WATCH_MS - 1), true, status);
    assert.equal(shouldPollReturn(status, LATE_WATCH_MS), false, status);
    assert.equal(nextPollDelayMs(0, status), LATE_POLL_MS, status);
    assert.equal(nextPollDelayMs(30, status), LATE_POLL_MS, status);
  }
});

test("C2b a new payment is only made after a fresh server answer says failed or expired (fail-first)", () => {
  assert.equal(canStartNewPayment("failed"), true);
  assert.equal(canStartNewPayment("expired"), true);
  for (const status of [
    "paid",
    "pending",
    "refunded",
    "partially_refunded",
    undefined,
  ])
    assert.equal(canStartNewPayment(status), false, String(status));
});

test("C2b only Duitku's own https pages may be opened (fail-first)", () => {
  for (const host of [
    "passport.duitku.com",
    "sandbox.duitku.com",
    "app-prod.duitku.com",
    "app-sandbox.duitku.com",
    "duitku.com",
  ])
    assert.equal(isDuitkuPageHost(host), true, host);
  for (const host of [
    "evil.com",
    "duitku.com.evil.com",
    "notduitku.com",
    "duitku.co",
    "evilduitku.com",
    "",
  ])
    assert.equal(isDuitkuPageHost(host), false, host);
});

test("C2b the record keeps the tenant theme and outlet zone, and reads old records without them (fail-first)", () => {
  const parsed = parseReturnRecord(serializeReturnRecord(tableRecord), now);
  assert.equal(parsed.timeZone, "Asia/Makassar");
  assert.deepEqual(parsed.theme, tableRecord.theme);
  // A record saved before this change has neither.
  const { theme, timeZone, ...old } = tableRecord;
  void theme;
  void timeZone;
  const legacy = parseReturnRecord(JSON.stringify(old), now);
  assert.equal(legacy.theme, null);
  assert.equal(legacy.timeZone, null);
  // A broken theme drops the theme, not the payment.
  const broken = parseReturnRecord(
    JSON.stringify({ ...tableRecord, theme: "red" }),
    now,
  );
  assert.equal(broken.theme, null);
  assert.equal(broken.paymentId, paymentId);
});

test("C2b a payment link card takes no channel, an e-wallet needs one", async () => {
  const { canSubmit } =
    await import("../apps/web/src/features/ws05-payment/status.ts");
  assert.equal(canSubmit("card", null), true);
  assert.equal(canSubmit("card", "VC"), false);
  assert.equal(canSubmit("ewallet", null), false);
  assert.equal(canSubmit("ewallet", "DA"), true);
});
