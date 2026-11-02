// Unit tests for the DESIGN v2 floor tile treatment (bead legend-6irt, owner
// Q25/Q27): which surface a table tile sits on and when it is urgent. The e2e
// spec checks the rendered CSS; this pins the pure mapping in ws03-floor/lib.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTableUrgent,
  tableTileLook,
  urgentTableCount,
} from "../apps/web/src/features/ws03-floor/lib.ts";

/** Minimal board row: only the fields the status/look helpers read. */
function row({
  table = "available",
  session = null,
  bill = 0,
  calls = 0,
} = {}) {
  return {
    table: { id: "t", code: "A01", zoneId: "z", status: table },
    session: session
      ? {
          status: session,
          billTotalIdr: bill,
          openedAt: "2026-11-02T03:00:00Z",
        }
      : null,
    openServiceRequestCount: calls,
  };
}

test("empty table sits on card with a border, not urgent", () => {
  assert.deepEqual(tableTileLook(row()), {
    surface: "card",
    urgent: false,
    calm: false,
    dashed: false,
    muted: false,
  });
});

test("occupied states sit on warm grey surface-3 (Q27)", () => {
  for (const r of [
    row({ session: "open", bill: 50_000 }),
    row({ session: "open" }),
    row({ session: "pending_confirmation" }),
    row({ table: "occupied" }),
  ])
    assert.equal(tableTileLook(r).surface, "surface-3");
});

test("bill requested is calm attention on surface-3, never urgent by itself", () => {
  const look = tableTileLook(row({ session: "bill_requested", bill: 10_000 }));
  assert.equal(look.surface, "surface-3");
  assert.equal(look.calm, true);
  assert.equal(look.urgent, false);
});

test("cleaning is dashed, inactive is muted surface-2, reserved stays card", () => {
  assert.equal(tableTileLook(row({ table: "dirty" })).dashed, true);
  const inactive = tableTileLook(row({ table: "inactive" }));
  assert.equal(inactive.surface, "surface-2");
  assert.equal(inactive.muted, true);
  assert.equal(tableTileLook(row({ table: "reserved" })).surface, "card");
});

test("an open waiter call makes any tile urgent (Q25) and is counted", () => {
  const rows = [
    row({ session: "open", calls: 1 }),
    row({ table: "dirty", calls: 2 }),
    row({ session: "bill_requested", bill: 1, calls: 0 }),
    row(),
  ];
  assert.equal(isTableUrgent(rows[0]), true);
  assert.equal(tableTileLook(rows[1]).urgent, true);
  assert.equal(tableTileLook(rows[1]).dashed, true);
  assert.equal(urgentTableCount(rows), 2);
  assert.equal(urgentTableCount([]), 0);
});
