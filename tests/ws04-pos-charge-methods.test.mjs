// Dearer-swap charge at the till: method picker rules (bead legend-t93l8).
// Money rule ("jangan sampai rugi"): never two payments for one charge, never
// a swap closed without money. Pure modules, loaded lazily (fail-first), plain
// Node ESM + type stripping like tests/ws04-pos-extra-logic.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const dir = "../apps/web/src/features/ws04-pos-order-detail";
const logic = () => import(`${dir}/charge-method-logic.ts`);
const keys = () => import(`${dir}/charge-key-store.ts`);

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
    // The server was read and says nothing is recorded: free to change, but a
    // retry of the same request still replays the same key.
    markChecked(s, scope);
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).key, first.key);
    markChecked(s, scope);
    const other = beginAttempt(s, scope, "qris:none", uuid);
    assert.equal(other.conflict, false);
    assert.notEqual(other.key, first.key);
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
