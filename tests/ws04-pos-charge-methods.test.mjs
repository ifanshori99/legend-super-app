// Dearer-swap charge at the till: method picker rules (bead legend-t93l8).
// Money rule ("jangan sampai rugi"): never two payments for one charge, never
// a swap closed without money. Pure modules, loaded lazily (fail-first), plain
// Node ESM + type stripping like tests/ws04-pos-extra-logic.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const dir = "../apps/web/src/features/ws04-pos-order-detail";
const logic = () => import(`${dir}/charge-method-logic.ts`);
const keys = () => import(`${dir}/charge-key-store.ts`);
const failures = () => import(`${dir}/charge-logic.ts`);
const messages = () =>
  import("../packages/shared/src/i18n/messages/pos-issue-charge.ts");

const qris = (status, extra = {}) => ({
  id: "p1",
  method: "qris",
  status,
  amountIdr: 10000,
  ...extra,
});
const sale = (status, extra = {}) => ({
  id: `sale-${status}`,
  status,
  amountIdr: 10000,
  method: "card",
  mode: "ecr",
  needsReconciliation: false,
  ...extra,
});
const charge = (extra = {}) => ({
  status: "open",
  amountIdr: 10000,
  payment: null,
  edcSales: [],
  ...extra,
});

describe("t93l8 chargePhase", () => {
  test("the charge status wins: paid and closed never collect", async () => {
    const { chargePhase } = await logic();
    assert.equal(chargePhase(charge({ status: "paid" })), "paid");
    // A QR that still reads pending never reopens a paid charge.
    assert.equal(
      chargePhase(charge({ status: "paid", payment: qris("pending") })),
      "paid",
    );
    for (const status of ["waived", "expired", "refunded", "something_new"])
      assert.equal(chargePhase(charge({ status })), "closed", status);
    assert.equal(chargePhase(charge({ status: "routed_pos" })), "choose");
  });

  test("a pending code locks the charge, an ended one frees it", async () => {
    const { chargePhase } = await logic();
    assert.equal(
      chargePhase(charge({ payment: qris("pending") })),
      "gateway_waiting",
    );
    for (const status of ["expired", "failed"])
      assert.equal(chargePhase(charge({ payment: qris(status) })), "choose");
  });

  test("money seen by the provider but not yet on the charge stays locked", async () => {
    const { chargePhase } = await logic();
    assert.equal(
      chargePhase(charge({ payment: qris("paid") })),
      "gateway_confirming",
    );
    for (const status of ["refunded", "partially_refunded", "new_status"])
      assert.equal(
        chargePhase(charge({ payment: qris(status) })),
        "review",
        status,
      );
  });

  test("a pending guest VA or e-wallet locks too", async () => {
    const { chargePhase } = await logic();
    assert.equal(
      chargePhase(charge({ payment: qris("pending", { method: "va" }) })),
      "gateway_waiting",
    );
  });

  test("a code for another amount goes to a supervisor", async () => {
    const { chargePhase } = await logic();
    for (const status of ["pending", "paid"])
      assert.equal(
        chargePhase(charge({ payment: qris(status, { amountIdr: 9000 }) })),
        "review",
      );
  });

  test("EDC pending or unknown locks, even next to a pending code", async () => {
    const { chargePhase } = await logic();
    for (const status of ["pending", "unknown", "new_status"]) {
      assert.equal(
        chargePhase(charge({ edcSales: [sale(status)] })),
        "edc_waiting",
        status,
      );
      assert.equal(
        chargePhase(
          charge({ edcSales: [sale(status)], payment: qris("pending") }),
        ),
        "edc_waiting",
      );
    }
  });

  test("refused EDC sales free the charge", async () => {
    const { chargePhase } = await logic();
    assert.equal(
      chargePhase(
        charge({
          edcSales: [sale("declined"), sale("cancelled"), sale("failed")],
        }),
      ),
      "choose",
    );
  });

  test("an approved sale must be recorded, nothing else", async () => {
    const { chargePhase } = await logic();
    assert.equal(
      chargePhase(charge({ edcSales: [sale("declined"), sale("approved")] })),
      "edc_approved",
    );
    // The bank already holds the money; recording it closes the open code.
    assert.equal(
      chargePhase(
        charge({ edcSales: [sale("approved")], payment: qris("pending") }),
      ),
      "edc_approved",
    );
  });

  test("double money or a bad sale goes to a supervisor", async () => {
    const { chargePhase } = await logic();
    const bad = [
      { edcSales: [sale("approved")], payment: qris("paid") },
      { edcSales: [sale("approved"), sale("approved", { id: "b" })] },
      { edcSales: [sale("approved", { amountIdr: 9999 })] },
      { edcSales: [sale("approved", { method: "qris" })] },
      { edcSales: [sale("approved", { mode: "standalone" })] },
      { edcSales: [sale("approved", { needsReconciliation: true })] },
      { edcSales: [sale("failed", { needsReconciliation: true })] },
    ];
    for (const extra of bad)
      assert.equal(chargePhase(charge(extra)), "review", JSON.stringify(extra));
    // Still running on the terminal while another is approved: wait first.
    assert.equal(
      chargePhase(charge({ edcSales: [sale("approved"), sale("unknown")] })),
      "edc_waiting",
    );
  });
});

describe("t93l8 canCollect", () => {
  const cash = { method: "cash", receivedIdr: 10000 };
  const code = { method: "qris" };
  const card = { method: "edc_card", edcTransactionId: "sale-approved" };

  test("cash and QRIS only when nothing is out", async () => {
    const { canCollect } = await logic();
    assert.equal(canCollect(charge(), cash), true);
    assert.equal(canCollect(charge(), code), true);
    const locked = [
      { payment: qris("pending") },
      { payment: qris("paid") },
      { edcSales: [sale("unknown")] },
      { edcSales: [sale("pending")] },
      { edcSales: [sale("approved")] },
      { status: "paid" },
      { status: "waived" },
    ];
    for (const extra of locked)
      for (const request of [cash, code])
        assert.equal(
          canCollect(charge(extra), request),
          false,
          `${request.method} ${JSON.stringify(extra)}`,
        );
  });

  test("cash must equal the server's amount", async () => {
    const { canCollect } = await logic();
    assert.equal(canCollect(charge(), { ...cash, receivedIdr: 9999 }), false);
    assert.equal(canCollect(charge(), { ...cash, receivedIdr: 10001 }), false);
  });

  test("EDC only with the approved sale the server listed", async () => {
    const { canCollect } = await logic();
    const ok = charge({ edcSales: [sale("approved")] });
    assert.equal(canCollect(ok, card), true);
    assert.equal(
      canCollect(ok, { ...card, edcTransactionId: "typed-by-hand" }),
      false,
    );
    assert.equal(canCollect(charge(), card), false);
    assert.equal(
      canCollect(charge({ edcSales: [sale("declined")] }), {
        ...card,
        edcTransactionId: "sale-declined",
      }),
      false,
    );
  });
});

describe("t93l8 poll and success", () => {
  test("polls exactly while something is out", async () => {
    const { chargePollMs } = await logic();
    assert.ok(chargePollMs(charge({ payment: qris("pending") })) > 0);
    assert.ok(chargePollMs(charge({ payment: qris("paid") })) > 0);
    assert.ok(chargePollMs(charge({ edcSales: [sale("unknown")] })) > 0);
    assert.equal(chargePollMs(charge()), false);
    assert.equal(chargePollMs(charge({ status: "paid" })), false);
    assert.equal(chargePollMs(undefined), false);
  });

  test("an answer settles only when the server says paid", async () => {
    const { answerSettles } = await logic();
    assert.equal(answerSettles({ charge: { status: "paid" } }), true);
    // The QRIS answer is a code, not money: the swap must stay unpaid.
    assert.equal(answerSettles({ charge: { status: "open" } }), false);
    assert.equal(answerSettles(undefined), false);
  });
});

describe("t93l8 idempotency key store", () => {
  const storage = () => {
    const map = new Map();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  };
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const scope = { outletId: "o1", chargeId: "c1" };

  test("the same request keeps its key across refresh and tabs", async () => {
    const { beginAttempt } = await keys();
    const s = storage();
    const first = beginAttempt(s, scope, "cash:10000", uuid);
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).key, first.key);
    assert.equal(first.conflict, false);
  });

  test("another request is refused while the last one is unresolved", async () => {
    const { beginAttempt, markChecked } = await keys();
    const s = storage();
    const first = beginAttempt(s, scope, "cash:10000", uuid);
    assert.equal(beginAttempt(s, scope, "qris:none", uuid).conflict, true);
    // The stored key survives the refusal.
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).key, first.key);
    // Reading the charge as open is not an answer for the key: another request
    // stays refused, the same one still replays the same key.
    markChecked(s, scope);
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).key, first.key);
    markChecked(s, scope);
    assert.equal(beginAttempt(s, scope, "qris:none", uuid).conflict, true);
  });

  test("a method change needs the server's 409/422 for that key and an open read", async () => {
    const { beginAttempt, markChecked, markRefused } = await keys();
    const s = storage();
    const first = beginAttempt(s, scope, "cash:10000", uuid);
    // Refused but the charge was not read since: still locked.
    markRefused(s, scope, first.key);
    assert.equal(beginAttempt(s, scope, "edc_card:a", uuid).conflict, true);
    markChecked(s, scope);
    const other = beginAttempt(s, scope, "edc_card:a", uuid);
    assert.equal(other.conflict, false);
    assert.notEqual(other.key, first.key);
    // A refusal for another key (another tab) proves nothing for this one.
    markRefused(s, scope, first.key);
    markChecked(s, scope);
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).conflict, true);
    // Sending again without a new refusal drops the old one.
    const again = beginAttempt(s, scope, "edc_card:a", uuid);
    markRefused(s, scope, again.key);
    beginAttempt(s, scope, "edc_card:a", uuid);
    markChecked(s, scope);
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).conflict, true);
  });

  test("a new QRIS is free once the server's payment id changed", async () => {
    const { beginAttempt, markChecked } = await keys();
    const s = storage();
    const first = beginAttempt(s, scope, "qris:none", uuid);
    markChecked(s, scope);
    const next = beginAttempt(s, scope, "qris:pay-1", uuid);
    assert.equal(next.conflict, false);
    assert.notEqual(next.key, first.key);
    // A code never frees cash or EDC.
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).conflict, true);
  });

  test("endAttempt only clears the key it was given", async () => {
    const { beginAttempt, endAttempt, hasUnresolved } = await keys();
    const s = storage();
    const mine = beginAttempt(s, scope, "cash:10000", uuid);
    endAttempt(s, scope, "00000000-0000-4000-8000-ffffffffffff");
    assert.equal(hasUnresolved(s, scope), true);
    endAttempt(s, scope, mine.key);
    assert.equal(hasUnresolved(s, scope), false);
  });

  test("unresolved is visible after a refresh, gone after a known answer", async () => {
    const { beginAttempt, endAttempt, hasUnresolved, markChecked } =
      await keys();
    const s = storage();
    assert.equal(hasUnresolved(s, scope), false);
    beginAttempt(s, scope, "cash:10000", uuid);
    assert.equal(hasUnresolved(s, scope), true);
    markChecked(s, scope);
    assert.equal(hasUnresolved(s, scope), false);
    beginAttempt(s, scope, "cash:10000", uuid);
    assert.equal(hasUnresolved(s, scope), true);
    endAttempt(s, scope);
    assert.equal(hasUnresolved(s, scope), false);
  });

  test("charges and outlets never share a key", async () => {
    const { beginAttempt } = await keys();
    const s = storage();
    const a = beginAttempt(s, scope, "cash:10000", uuid).key;
    const b = beginAttempt(s, { ...scope, chargeId: "c2" }, "cash:10000", uuid);
    const c = beginAttempt(s, { ...scope, outletId: "o2" }, "cash:10000", uuid);
    assert.equal(new Set([a, b.key, c.key]).size, 3);
  });

  test("a corrupted entry is never sent as a key", async () => {
    const { beginAttempt } = await keys();
    const s = storage();
    beginAttempt(s, scope, "cash:10000", uuid);
    const broken = { ...s, getItem: () => "{not json" };
    const next = beginAttempt(broken, scope, "cash:10000", uuid);
    assert.match(next.key, /^[0-9a-f-]{36}$/);
  });

  test("a renewed QRIS is a new request, a retry is not", async () => {
    const { requestSignature } = await logic();
    const none = requestSignature(charge(), { method: "qris" });
    assert.equal(none, requestSignature(charge(), { method: "qris" }));
    assert.notEqual(
      none,
      requestSignature(charge({ payment: qris("expired") }), {
        method: "qris",
      }),
    );
    assert.notEqual(
      requestSignature(charge(), { method: "edc_card", edcTransactionId: "a" }),
      requestSignature(charge(), { method: "edc_card", edcTransactionId: "b" }),
    );
  });
});

describe("1267 H1 refusals, texts and deadline", () => {
  test("only 409/422 free the key for another method; auth and limits keep it", async () => {
    const { collectKeyAfter } = await failures();
    assert.equal(collectKeyAfter(409), "refused");
    assert.equal(collectKeyAfter(422), "refused");
    for (const status of [401, 403, 429, 0, 408, 500, 502])
      assert.equal(collectKeyAfter(status), "keep", String(status));
    for (const status of [400, 404, 410])
      assert.equal(collectKeyAfter(status), "end", String(status));
  });

  test("every closed charge status has catalog text", async () => {
    const { posIssueChargeMessages } = await messages();
    const { status } =
      posIssueChargeMessages.posIssueCharge ?? posIssueChargeMessages;
    for (const key of ["waived", "expired", "voided"])
      assert.equal(typeof status[key], "string", key);
  });

  test("a hanging request ends as unknown after the deadline, never as a failure", async () => {
    const { withDeadline, CollectDeadlineError } = await logic();
    await assert.rejects(
      withDeadline(new Promise(() => {}), 10),
      CollectDeadlineError,
    );
    assert.equal(await withDeadline(Promise.resolve("ok"), 1000), "ok");
    await assert.rejects(
      withDeadline(Promise.reject(new Error("boom")), 1000),
      /boom/,
    );
  });
});
