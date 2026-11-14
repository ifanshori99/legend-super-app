// EDC reconciliation gate (bead legend-khi8n, brief docs/briefs/sub-865-edc-recon-ui.md
// part E). The screen decides from `reconciliationGate` whether the resolve form
// is open, locked (terminal still processing), too early, or not eligible, and
// which outcomes it may offer. Rules come from the brief and the mockup README:
// - a sale still on the wire (saleWireOpenAt set) locks the form;
// - an `unknown` sale may be reconciled only 10 minutes after dispatchedAt;
// - only flagged (needsReconciliation) approved/declined rows, or unknown rows,
//   are eligible; pending, cancelled and failed never are;
// - approved can only be settled approved, declined only declined, unknown both.
// ASSUMPTIONS: wire-open wins over too-early; an unknown row is eligible with
// or without the flag once the 10 minutes passed; ageMinutes floors whole
// minutes since createdAt; `outcomes` order is not asserted.
// Run: node --experimental-strip-types --test tests/edc-reconciliation-gate.test.mjs
// (written before lib.ts exists: the import below fails until it does).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { EDC_RECON_WAIT_MS, ageMinutes, reconciliationGate } =
  await import("../apps/web/src/features/edc-reconciliation/lib.ts");

const NOW = Date.parse("2026-11-15T03:00:00.000Z"); // 10.00 WIB
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** A queue item whose sale was dispatched `dispatchedAgoMs` before NOW. */
function item({
  status = "unknown",
  needsReconciliation = true,
  dispatchedAgoMs = 42 * MIN,
  createdAgoMs = dispatchedAgoMs ?? 42 * MIN,
  saleWireOpenAt = null,
} = {}) {
  return {
    transaction: {
      id: "5b1f0f6e-0000-4000-8000-000000001048",
      status,
      needsReconciliation,
      amountIdr: 425000,
      dispatchedAt:
        dispatchedAgoMs === null ? null : iso(NOW - dispatchedAgoMs),
      createdAt: iso(NOW - createdAgoMs),
    },
    outletName: "Legend Senopati",
    cashierName: "Dimas",
    terminalLabel: "EDC-SNP-02 · BCA",
    billNumber: "INV-1511-084",
    remainingIdr: 425000,
    saleWireOpenAt,
  };
}

const sorted = (list) => [...list].sort();

describe("EDC_RECON_WAIT_MS", () => {
  test("is exactly ten minutes", () => {
    assert.equal(EDC_RECON_WAIT_MS, 10 * 60 * 1000);
  });
});

describe("reconciliationGate: terminal still processing", () => {
  test("a sale with an open wire is locked", () => {
    const gate = reconciliationGate(
      item({ saleWireOpenAt: iso(NOW - 2 * MIN) }),
      NOW,
    );
    assert.equal(gate.kind, "wire-open");
  });

  test("the wire lock wins over the 10 minute wait (EDC-1061: 2 minutes)", () => {
    const gate = reconciliationGate(
      item({ dispatchedAgoMs: 2 * MIN, saleWireOpenAt: iso(NOW - 2 * MIN) }),
      NOW,
    );
    assert.equal(gate.kind, "wire-open");
  });

  test("an old unknown sale is still locked while the wire is open", () => {
    const gate = reconciliationGate(
      item({ dispatchedAgoMs: 42 * MIN, saleWireOpenAt: iso(NOW - 40 * MIN) }),
      NOW,
    );
    assert.equal(gate.kind, "wire-open");
  });

  test("a flagged approved sale with an open wire is locked too", () => {
    const gate = reconciliationGate(
      item({ status: "approved", saleWireOpenAt: iso(NOW - MIN) }),
      NOW,
    );
    assert.equal(gate.kind, "wire-open");
  });
});

describe("reconciliationGate: unknown needs ten minutes", () => {
  test("9:59 after dispatch is too early and says when it opens", () => {
    const dispatchedAgoMs = 10 * MIN - 1000;
    const gate = reconciliationGate(item({ dispatchedAgoMs }), NOW);
    assert.equal(gate.kind, "too-early");
    assert.equal(gate.eligibleAtMs, NOW - dispatchedAgoMs + EDC_RECON_WAIT_MS);
    assert.equal(gate.eligibleAtMs, NOW + 1000);
  });

  test("exactly 10:00 after dispatch is open", () => {
    const gate = reconciliationGate(item({ dispatchedAgoMs: 10 * MIN }), NOW);
    assert.equal(gate.kind, "open");
  });

  test("10:01 after dispatch is open", () => {
    const gate = reconciliationGate(
      item({ dispatchedAgoMs: 10 * MIN + 1000 }),
      NOW,
    );
    assert.equal(gate.kind, "open");
  });

  test("an unknown sale without the flag, dispatched 4 minutes ago, is too early", () => {
    const gate = reconciliationGate(
      item({ needsReconciliation: false, dispatchedAgoMs: 4 * MIN }),
      NOW,
    );
    assert.equal(gate.kind, "too-early");
    assert.equal(gate.eligibleAtMs, NOW + 6 * MIN);
  });

  test("an old unknown sale without the flag is open", () => {
    const gate = reconciliationGate(
      item({ needsReconciliation: false, dispatchedAgoMs: 30 * MIN }),
      NOW,
    );
    assert.equal(gate.kind, "open");
  });

  test("the wait counts from dispatchedAt, not from createdAt", () => {
    const gate = reconciliationGate(
      item({ dispatchedAgoMs: 3 * MIN, createdAgoMs: 60 * MIN }),
      NOW,
    );
    assert.equal(gate.kind, "too-early");
  });
});

describe("reconciliationGate: outcome per status", () => {
  test("unknown may be settled approved or declined", () => {
    const gate = reconciliationGate(item({ status: "unknown" }), NOW);
    assert.equal(gate.kind, "open");
    assert.deepEqual(sorted(gate.outcomes), ["approved", "declined"]);
  });

  test("a flagged approved sale can only be settled approved", () => {
    const gate = reconciliationGate(
      item({ status: "approved", dispatchedAgoMs: 1 * MIN }),
      NOW,
    );
    assert.equal(gate.kind, "open");
    assert.deepEqual(gate.outcomes, ["approved"]);
  });

  test("a flagged declined sale can only be settled declined", () => {
    const gate = reconciliationGate(
      item({ status: "declined", dispatchedAgoMs: 1 * MIN }),
      NOW,
    );
    assert.equal(gate.kind, "open");
    assert.deepEqual(gate.outcomes, ["declined"]);
  });
});

describe("reconciliationGate: not eligible", () => {
  // The mockup README: "Pending/in-flight menolak kedua keputusan". A flagged
  // cancelled/failed row (approved late) may only be settled declined; the
  // coordinator confirmed this against the service (approved is refused).
  for (const status of ["cancelled", "failed"]) {
    test(`${status} flagged is open for declined only`, () => {
      const gate = reconciliationGate(
        item({ status, needsReconciliation: true, dispatchedAgoMs: 1 * MIN }),
        NOW,
      );
      assert.equal(gate.kind, "open");
      assert.deepEqual(gate.outcomes, ["declined"]);
    });
  }

  test("pending is never eligible, flagged or not", () => {
    for (const needsReconciliation of [true, false]) {
      const gate = reconciliationGate(
        item({ status: "pending", needsReconciliation }),
        NOW,
      );
      assert.equal(gate.kind, "not-eligible", `flag ${needsReconciliation}`);
    }
  });

  for (const status of ["cancelled", "failed"]) {
    test(`${status} without the flag is not eligible`, () => {
      const gate = reconciliationGate(
        item({ status, needsReconciliation: false }),
        NOW,
      );
      assert.equal(gate.kind, "not-eligible");
    });
  }

  for (const status of ["approved", "declined"]) {
    test(`${status} without the flag is not eligible`, () => {
      const gate = reconciliationGate(
        item({ status, needsReconciliation: false }),
        NOW,
      );
      assert.equal(gate.kind, "not-eligible");
    });
  }

  test("not-eligible offers no outcome", () => {
    const gate = reconciliationGate(item({ status: "pending" }), NOW);
    assert.equal(gate.outcomes, undefined);
  });
});

describe("ageMinutes", () => {
  test("counts whole minutes since createdAt", () => {
    assert.equal(ageMinutes(item({ createdAgoMs: 42 * MIN }), NOW), 42);
    assert.equal(
      ageMinutes(item({ createdAgoMs: 42 * MIN + 59_000 }), NOW),
      42,
    );
  });

  test("a sale created just now is 0 minutes old", () => {
    assert.equal(ageMinutes(item({ createdAgoMs: 0 }), NOW), 0);
  });
});
