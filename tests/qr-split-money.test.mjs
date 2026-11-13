// Split bill money invariants (ORD-06; bead legend-arp35, brief ws03-qr-menu-cards
// card 2). Derived from docs/plan/contracts.md ("Splits sum exactly (ORD-06)"),
// the shared contract (`splitBill`, `assertSplitsSumToTotal`) and the web error
// contract named in the brief (SPLIT_LOCKED, NOTHING_TO_SPLIT). The API route
// behaviour (NOTHING_TO_SPLIT 422, SPLIT_LOCKED 409, exact sums on a real order
// with tax + service) is already covered by apps/api/src/test/bill-split*.test.ts;
// this file covers the pure parts: rounding sweeps and the web side.
//
// Assumptions:
// - Modifiers and tax/service are already folded into each line total and into
//   the order total, so the by-item sweep uses arbitrary line totals (some with
//   a modifier-like odd surcharge) and an order total that differs from their sum.
// - Remainder rule (contracts.md): leftover rupiah go to the lowest indexes, so
//   equal parts never increase with the index.
// - The web must turn the two server codes into guest-readable states. No such
//   mapper exists yet, so the test names one: `splitCreateErrorKind(error)` in
//   ws03-qr-order/domain.ts returning "locked" (SPLIT_LOCKED), "nothing"
//   (NOTHING_TO_SPLIT), "cashier" (CONFLICT, VALIDATION_ERROR) or "generic"
//   (anything else). Rename here if the
//   engineer picks another name; the behaviour is what matters.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";
import * as domain from "../apps/web/src/features/ws03-qr-order/domain.ts";

const sum = (values) => values.reduce((total, value) => total + value, 0);

// Small deterministic generator: the sweep must be repeatable, never flaky.
function lcg(seed) {
  let state = seed >>> 0;
  return (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

describe("ORD-06 equal split sweep", () => {
  const totals = [1, 2, 3, 49, 50, 51, 99, 101, 1_001, 51_665, 99_999, 100_001];

  test("ORD-06 parts sum exactly to the total for every total and part count", () => {
    for (const total of totals)
      for (let parts = 1; parts <= Math.min(50, total); parts += 1) {
        const amounts = qr
          .splitBill({ method: "equal", totalIdr: total, parts })
          .map((part) => part.amountIdr);
        assert.equal(amounts.length, parts, `${total}/${parts} part count`);
        assert.equal(sum(amounts), total, `${total}/${parts} sum`);
        assert.ok(
          amounts.every((amount) => Number.isInteger(amount) && amount > 0),
          `${total}/${parts} whole positive rupiah`,
        );
        assert.ok(
          Math.max(...amounts) - Math.min(...amounts) <= 1,
          `${total}/${parts} spread`,
        );
        for (let index = 1; index < amounts.length; index += 1)
          assert.ok(
            amounts[index] <= amounts[index - 1],
            `${total}/${parts} remainder goes to the lowest indexes`,
          );
      }
  });

  test("ORD-06 an odd total split in two leaves the extra rupiah on the first part", () => {
    const [first, second] = qr
      .splitBill({ method: "equal", totalIdr: 100_001, parts: 2 })
      .map((part) => part.amountIdr);
    assert.equal(first, 50_001);
    assert.equal(second, 50_000);
  });

  test("ORD-06 the guest preview shows exactly what the server helper allocates", () => {
    for (const total of totals)
      for (const parts of [2, 3, 7])
        assert.deepEqual(
          domain.previewEqualSplit(total, parts),
          qr
            .splitBill({ method: "equal", totalIdr: total, parts })
            .map((part) => part.amountIdr),
        );
  });
});

describe("ORD-06 by-person split sweep", () => {
  test("ORD-06 one whole part per person, summing exactly to the total", () => {
    for (const total of [7, 100, 51_665, 100_001])
      for (let people = 1; people <= 12; people += 1) {
        const participantIds = Array.from(
          { length: people },
          (_, index) => `p${index}`,
        );
        const parts = qr.splitBill({
          method: "by_person",
          totalIdr: total,
          participantIds,
        });
        assert.equal(sum(parts.map((part) => part.amountIdr)), total);
        assert.deepEqual(
          parts.map((part) => part.participantId),
          participantIds,
        );
      }
  });
});

describe("ORD-06 by-item split sweep (modifiers and tax inside the total)", () => {
  test("ORD-06 parts sum exactly and stay within one rupiah of their weighted share", () => {
    const next = lcg(20261113);
    for (let round = 0; round < 200; round += 1) {
      const itemCount = 2 + next(7);
      // Line totals include modifiers: base price plus an odd surcharge.
      const lines = Array.from({ length: itemCount }, (_, index) => ({
        orderItemId: `item-${index}`,
        lineTotalIdr: (1 + next(60)) * 500 + next(4) * 1_500 + next(3) * 250,
      }));
      const subtotal = sum(lines.map((line) => line.lineTotalIdr));
      // Total = subtotal + service + tax + rounding: never equal to the subtotal.
      const total = subtotal + Math.floor(subtotal * 0.155) + next(1_000);

      const partCount = 2 + next(Math.min(4, itemCount - 1));
      const assignments = Array.from({ length: partCount }, () => ({
        orderItemIds: [],
      }));
      lines.forEach((line, index) =>
        // The first partCount items seed every part so none is empty.
        assignments[
          index < partCount ? index : next(partCount)
        ].orderItemIds.push(line.orderItemId),
      );

      const parts = qr.splitBill({
        method: "by_item",
        totalIdr: total,
        lines,
        assignments,
      });
      const amounts = parts.map((part) => part.amountIdr);
      assert.equal(sum(amounts), total, `round ${round} sum`);
      qr.assertSplitsSumToTotal(parts, total);
      assert.equal(
        sum(domain.previewItemSplit(total, lines, assignments)),
        total,
        `round ${round} guest preview sum`,
      );
      amounts.forEach((amount, index) => {
        const weight = sum(
          assignments[index].orderItemIds.map(
            (id) => lines.find((line) => line.orderItemId === id).lineTotalIdr,
          ),
        );
        // Largest remainder: |amount - total*weight/subtotal| < 1, kept in
        // integers so no float error can hide a rupiah.
        const diff = Math.abs(amount * subtotal - total * weight);
        assert.ok(diff < subtotal, `round ${round} part ${index} fairness`);
      });
    }
  });

  test("ORD-06 a split that would not sum to the total is refused by the guard", () => {
    const parts = qr.splitBill({
      method: "equal",
      totalIdr: 100_001,
      parts: 3,
    });
    // One rupiah short or over must throw; voided parts do not count.
    assert.throws(
      () =>
        qr.assertSplitsSumToTotal(
          parts.map((part, index) =>
            index === 0 ? { ...part, amountIdr: part.amountIdr - 1 } : part,
          ),
          100_001,
        ),
      RangeError,
    );
    assert.throws(
      () =>
        qr.assertSplitsSumToTotal(
          parts.map((part, index) =>
            index === 0 ? { ...part, amountIdr: part.amountIdr + 1 } : part,
          ),
          100_001,
        ),
      RangeError,
    );
    qr.assertSplitsSumToTotal(
      [...parts, { amountIdr: 12_345, status: "voided" }],
      100_001,
    );
  });
});

describe("ORD-06 web: server split errors reach the guest", () => {
  test("ORD-06 SPLIT_LOCKED is told apart: a paid part locks the bill", () => {
    assert.equal(typeof domain.splitCreateErrorKind, "function");
    assert.equal(
      domain.splitCreateErrorKind(
        new ApiError(409, "SPLIT_LOCKED", "Tagihan sudah dibayar sebagian."),
      ),
      "locked",
    );
  });

  test("ORD-06 NOTHING_TO_SPLIT is told apart: no awaiting bill", () => {
    assert.equal(typeof domain.splitCreateErrorKind, "function");
    assert.equal(
      domain.splitCreateErrorKind(
        new ApiError(422, "NOTHING_TO_SPLIT", "Tidak ada tagihan."),
      ),
      "nothing",
    );
  });

  test("ORD-06 CONFLICT and VALIDATION_ERROR send the guest to the cashier", () => {
    assert.equal(
      domain.splitCreateErrorKind(
        new ApiError(409, "CONFLICT", "Lebih dari satu pesanan."),
      ),
      "cashier",
    );
    assert.equal(
      domain.splitCreateErrorKind(new ApiError(422, "VALIDATION_ERROR", "x")),
      "cashier",
    );
  });

  test("ORD-06 any other failure, or a non-API error, is the generic state", () => {
    assert.equal(typeof domain.splitCreateErrorKind, "function");
    assert.equal(
      domain.splitCreateErrorKind(new ApiError(500, "INTERNAL", "boom")),
      "generic",
    );
    assert.equal(domain.splitCreateErrorKind(new Error("offline")), "generic");
    assert.equal(domain.splitCreateErrorKind(null), "generic");
  });
});
