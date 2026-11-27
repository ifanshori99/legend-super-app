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

describe("legend-f1mmf blockers a, b, c, e", () => {
  const storage = () => {
    const map = new Map();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  };
  let n = 100;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const scope = { outletId: "o1", chargeId: "c1" };

  test("(a) an attempt without an answer holds the picker to its own method", async () => {
    const { beginAttempt, lockedAttempt, markChecked, markRefused } =
      await keys();
    const { methodOfSignature } = await logic();
    const s = storage();
    assert.equal(lockedAttempt(s, scope), null);
    const first = beginAttempt(s, scope, "cash:10000", uuid);
    // Still held after a read of the charge as open.
    markChecked(s, scope);
    const lock = lockedAttempt(s, scope);
    assert.equal(lock?.key, first.key);
    assert.equal(methodOfSignature(lock.signature), "cash");
    // Freed only by the server's refusal for that key plus an open read.
    markRefused(s, scope, first.key);
    assert.equal(lockedAttempt(s, scope), null);
    assert.equal(methodOfSignature("edc:t1"), "edc_card");
    assert.equal(methodOfSignature("edc_card:s1"), "edc_card");
    assert.equal(methodOfSignature("qris:none"), "qris");
  });

  test("(b) 401/403/429 on a key's first send end it; on a replay they keep it", async () => {
    const { collectKeyAfter, edcStartKeyAfter } = await failures();
    for (const status of [401, 403, 429]) {
      assert.equal(collectKeyAfter(status, true), "end", String(status));
      assert.equal(collectKeyAfter(status, false), "keep", String(status));
    }
    // An unknown result keeps the key even on the first send.
    for (const status of [0, 408, 500, 504])
      assert.equal(collectKeyAfter(status, true), "keep", String(status));
    assert.equal(collectKeyAfter(409, true), "refused");
    // P3-1: the agent also answers EDC_AGENT_NOT_READY after the sale was
    // written ahead: a 503 is unknown, the key stays, the server is read first.
    assert.equal(edcStartKeyAfter(503, true), "keep");
    assert.equal(edcStartKeyAfter(503, false), "keep");
    assert.equal(edcStartKeyAfter(401, true), "end");
  });

  test("(b) beginAttempt says whether the key was sent before", async () => {
    const { beginAttempt } = await keys();
    const s = storage();
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).firstSend, true);
    assert.equal(beginAttempt(s, scope, "cash:10000", uuid).firstSend, false);
  });

  test("(c) a QRIS attempt frees every method once the server's new code ended", async () => {
    const { beginAttempt, lockedAttempt, markChecked } = await keys();
    const { codeFacts } = await logic();
    const s = storage();
    beginAttempt(s, scope, "qris:none", uuid);
    markChecked(s, scope);
    const live = codeFacts(charge({ payment: qris("pending", { id: "p2" }) }));
    assert.notEqual(lockedAttempt(s, scope, live), null);
    assert.equal(
      beginAttempt(s, scope, "cash:10000", uuid, live).conflict,
      true,
    );
    const ended = codeFacts(charge({ payment: qris("expired", { id: "p2" }) }));
    assert.equal(lockedAttempt(s, scope, ended), null);
    assert.equal(
      beginAttempt(s, scope, "cash:10000", uuid, ended).conflict,
      false,
    );
    // The same code the request named proves nothing: still held.
    const t = storage();
    beginAttempt(t, scope, "qris:p1", uuid);
    const same = codeFacts(charge({ payment: qris("failed", { id: "p1" }) }));
    assert.notEqual(lockedAttempt(t, scope, same), null);
    assert.equal(beginAttempt(t, scope, "edc:t1", uuid, same).conflict, true);
  });

  test("(e) the read before sending is aborted after its deadline", async () => {
    const { readWithin, PrecheckDeadlineError } = await logic();
    let aborted = false;
    await assert.rejects(
      readWithin(
        (signal) =>
          new Promise(() => {
            signal.addEventListener("abort", () => (aborted = true));
          }),
        10,
      ),
      PrecheckDeadlineError,
    );
    assert.equal(aborted, true);
    assert.equal(await readWithin(async () => "open", 1000), "open");
  });

  test("a card start keeps its key per sale for the supervisor's settle", async () => {
    const { rememberSaleKey, saleStartKey } = await keys();
    const { requestSignature, terminalOfSignature } = await logic();
    const s = storage();
    const key = uuid();
    rememberSaleKey(s, scope, "sale-1", key);
    assert.equal(saleStartKey(s, scope, "sale-1"), key);
    assert.equal(saleStartKey(s, scope, "sale-2"), null);
    assert.equal(saleStartKey(s, { ...scope, chargeId: "c2" }, "sale-1"), null);
    const sig = requestSignature(charge(), {
      method: "edc_start",
      terminalId: "t1",
    });
    assert.equal(terminalOfSignature(sig), "t1");
  });
});

describe("legend-f1mmf web review P1: a card start that answered late", () => {
  const storage = () => {
    const map = new Map();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  };
  let n = 500;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const scope = { outletId: "o1", chargeId: "c1" };

  test("the start's key moves to recording only the approved matching sale on its terminal", async () => {
    const { beginAttempt, markChecked } = await keys();
    const { codeFacts, EDC_START_DEADLINE_MS } = await logic();
    // The agent waits up to 120 s for the terminal; the screen waits longer.
    assert.ok(EDC_START_DEADLINE_MS >= 150_000);
    const s = storage();
    const start = beginAttempt(s, scope, "edc:t1", uuid);
    markChecked(s, scope);
    const approved = (extra) =>
      codeFacts(
        charge({
          edcSales: [
            sale("approved", { id: "s1", terminalId: "t1", ...extra }),
          ],
        }),
      );
    // Another terminal, another amount, a flagged sale or none: still held.
    for (const facts of [
      codeFacts(charge()),
      approved({ terminalId: "t2" }),
      approved({ amountIdr: 9000 }),
      approved({ needsReconciliation: true }),
    ])
      assert.equal(
        beginAttempt(s, scope, "edc_card:s1", uuid, facts).conflict,
        true,
      );
    // Another sale id than the one approved: held.
    assert.equal(
      beginAttempt(s, scope, "edc_card:s2", uuid, approved()).conflict,
      true,
    );
    const record = beginAttempt(s, scope, "edc_card:s1", uuid, approved());
    assert.equal(record.conflict, false);
    assert.notEqual(record.key, start.key);
    // Cash never follows a card start this way.
    const t = storage();
    beginAttempt(t, scope, "edc:t1", uuid);
    assert.equal(
      beginAttempt(t, scope, "cash:10000", uuid, approved()).conflict,
      true,
    );
  });
});

describe("legend-f1mmf recheck: errors and background reads", () => {
  // 1273 P3-4: the card start of a charge is edge-only (cloud answers 503
  // EDC_AGENT_NOT_READY), so the sentence must point to what works there.
  test("the cloud 503 of the card start names QRIS, cash and the supervisor's slip way out", async () => {
    const { chargeErrorKey } = await failures();
    const { posIssueChargeMessages } = await messages();
    assert.equal(
      chargeErrorKey("EDC_AGENT_NOT_READY"),
      "posIssueCharge.edc.notReady",
    );
    const text = posIssueChargeMessages.edc.notReady;
    assert.match(text, /QRIS/);
    assert.match(text, /tunai/);
    assert.match(text, /slip/);
    // 1273 review P2: resolving a never-started card closes the attempt only,
    // so the sentence must not promise the slip gets recorded there.
    assert.doesNotMatch(text, /lewat penyelesaian/);
    assert.match(text, /jangan tagih lagi/);
  });

  test("an unknown server code reads as the catalog's plain sentence, never the server's text", async () => {
    const { chargeErrorKey } = await failures();
    const { posIssueChargeMessages } = await messages();
    const text = (key) =>
      key
        .split(".")
        .slice(1)
        .reduce((node, part) => node?.[part], posIssueChargeMessages);
    for (const code of ["SOMETHING_NEW", "VALIDATION_ERROR", null, undefined])
      assert.equal(chargeErrorKey(code), "posIssueCharge.error.generic");
    assert.equal(chargeErrorKey("toString"), "posIssueCharge.error.generic");
    assert.equal(
      chargeErrorKey("PIN_INVALID"),
      "posIssueCharge.error.pinInvalid",
    );
    assert.equal(
      chargeErrorKey("EDC_AGENT_NOT_READY"),
      "posIssueCharge.edc.notReady",
    );
    for (const code of [
      "SOMETHING_NEW",
      "EDC_AGENT_NOT_READY",
      "ISSUE_CHARGE_EDC_STATEMENT_REQUIRED",
      "ISSUE_CHARGE_SLIP_REQUIRED",
      "PIN_INVALID",
      "PIN_LOCKED",
      "PIN_DEVICE_THROTTLED",
      "RATE_LIMITED",
      "CONFLICT",
    ])
      assert.equal(typeof text(chargeErrorKey(code)), "string", code);
  });

  test("a background read is cancelled with its query and bounded by the deadline", async () => {
    const { readWithin, PrecheckDeadlineError } = await logic();
    const outer = new AbortController();
    let aborted = false;
    const read = readWithin(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      2_000,
      outer.signal,
    );
    outer.abort();
    const settled = await Promise.race([
      read.then(
        () => "resolved",
        (error) => error,
      ),
      new Promise((done) => setTimeout(() => done("still running"), 300)),
    ]);
    assert.ok(settled instanceof Error, String(settled));
    assert.ok(!(settled instanceof PrecheckDeadlineError));
    assert.equal(aborted, true);
    await assert.rejects(
      readWithin(() => new Promise(() => {}), 10, new AbortController().signal),
      PrecheckDeadlineError,
    );
  });
});
