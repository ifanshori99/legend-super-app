// Pure rules of the stock-opname and waste screens (bead legend-fzx, PRD v1.7
// §16 "Stok Opname" / "Waste & Spoilage", §4 Alur J). Acceptance ID: INV-03
// (the adjustment is never booked before a different person approves it).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedCountActions,
  canApproveCount,
  countProgress,
  hidesSystemQty,
  lineDelta,
  statusGroup,
  varianceLineCount,
  varianceTotalIdr,
  wasteLossTotal,
} from "../apps/web/src/features/ws06-inventory/opname-lib.ts";

const counter = "6f1c2a90-0000-4000-8000-00000000aaaa";
const manager = "6f1c2a90-0000-4000-8000-00000000bbbb";

function count(overrides = {}) {
  return {
    id: "c0de0000-0000-4000-8000-000000000001",
    status: "pending_approval",
    countedBy: counter,
    blind: true,
    ...overrides,
  };
}

function line(overrides = {}) {
  return {
    id: "1a2b0000-0000-4000-8000-000000000001",
    systemQty: "14.0000",
    countedQty: "13.5000",
    varianceIdr: -11250,
    ...overrides,
  };
}

const capabilities = { canCount: true, canApprove: true };

test("INV-03: the counter never approves their own count, another manager does", () => {
  const submitted = count();
  assert.equal(canApproveCount(submitted, counter), false);
  assert.equal(canApproveCount(submitted, manager), true);
  assert.deepEqual(
    allowedCountActions(submitted, [line()], counter, capabilities),
    ["reject", "cancel"],
  );
  assert.ok(
    allowedCountActions(submitted, [line()], manager, capabilities).includes(
      "approve",
    ),
  );
});

test("INV-03: approval is offered only after submission, posting only after approval", () => {
  const lines = [line()];
  assert.deepEqual(
    allowedCountActions(
      count({ status: "counting" }),
      lines,
      manager,
      capabilities,
    ),
    ["submit", "cancel"],
  );
  assert.deepEqual(
    allowedCountActions(
      count({ status: "approved", approvedBy: manager }),
      lines,
      manager,
      capabilities,
    ),
    ["post"],
  );
  assert.deepEqual(
    allowedCountActions(
      count({ status: "posted" }),
      lines,
      manager,
      capabilities,
    ),
    [],
  );
  // A viewer without the approval permission gets no state-changing action.
  assert.deepEqual(
    allowedCountActions(count(), lines, manager, {
      canCount: false,
      canApprove: false,
    }),
    [],
  );
});

test("INV-03: a count cannot be submitted until every line has a physical quantity", () => {
  const partial = [
    line(),
    line({ id: "second", countedQty: null, varianceIdr: null }),
  ];
  assert.deepEqual(countProgress(partial), {
    counted: 1,
    total: 2,
    complete: false,
  });
  assert.deepEqual(
    allowedCountActions(
      count({ status: "counting" }),
      partial,
      manager,
      capabilities,
    ),
    ["cancel"],
  );
  assert.deepEqual(countProgress([line()]), {
    counted: 1,
    total: 1,
    complete: true,
  });
});

test("INV-03: a blind count hides the system quantity while counting and from non-approvers in review", () => {
  assert.equal(hidesSystemQty(count({ status: "draft" })), true);
  assert.equal(hidesSystemQty(count({ status: "counting" })), true);
  assert.equal(hidesSystemQty(count({ status: "counting" }), true), true);
  // A reject sends the count back to counting, so the counter must not see
  // the system figures during review (Alur J step 2).
  assert.equal(hidesSystemQty(count({ status: "pending_approval" })), true);
  assert.equal(
    hidesSystemQty(count({ status: "pending_approval" }), true),
    false,
  );
  assert.equal(hidesSystemQty(count({ status: "approved" })), false);
  assert.equal(
    hidesSystemQty(count({ status: "counting", blind: false })),
    false,
  );
});

test("INV-03: variance review sums rupiah and counts only lines that differ", () => {
  const lines = [
    line(),
    line({
      id: "b",
      systemQty: "10.0000",
      countedQty: "9.8000",
      varianceIdr: -5600,
    }),
    line({
      id: "c",
      systemQty: "7.5000",
      countedQty: "7.5000",
      varianceIdr: 0,
    }),
    line({ id: "d", systemQty: "2.0000", countedQty: null, varianceIdr: null }),
  ];
  assert.equal(lineDelta(lines[0]), "-0,5");
  assert.equal(lineDelta(lines[3]), null);
  assert.equal(varianceLineCount(lines), 2);
  assert.equal(varianceTotalIdr(lines), -16850);
});

test("INV-03: list filters group statuses for the session list", () => {
  assert.equal(statusGroup("draft"), "active");
  assert.equal(statusGroup("counting"), "active");
  assert.equal(statusGroup("pending_approval"), "pending");
  assert.equal(statusGroup("approved"), "done");
  assert.equal(statusGroup("posted"), "done");
  assert.equal(statusGroup("cancelled"), "done");
});

test("waste: the loss total adds every logged rupiah value", () => {
  assert.equal(
    wasteLossTotal([{ valueIdr: 33750 }, { valueIdr: 12000 }, { valueIdr: 0 }]),
    45750,
  );
});
