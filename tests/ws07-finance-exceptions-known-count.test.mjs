// Finance exceptions distinguish an unknown sum from known zero rupiah
// (legend-j4xdb). Summary counts cover every row, including cut-off items.
import assert from "node:assert/strict";
import { test } from "node:test";
import { financeExceptionsResponseSchema } from "../apps/web/src/features/ws07-finance-exceptions/endpoint.ts";
import {
  addDays,
  jakartaToday,
  summarizeByKind,
} from "../apps/web/src/features/ws07-finance-exceptions/lib.ts";
import { findMock } from "../apps/web/src/lib/mock/registry.ts";
import "../apps/web/src/features/ws07-finance-exceptions/mock.ts";

const kind = "edge_receipt_skipped";
const summaryRow = (overrides = {}) => ({
  kind,
  count: 2,
  amountIdr: 0,
  knownAmountCount: 0,
  ...overrides,
});

function summarize(row, items = [], truncated = false) {
  return summarizeByKind([row], items, truncated).find(
    (entry) => entry.kind === row.kind,
  );
}

test("finance exceptions: the strict response accepts known amount counts", () => {
  const response = {
    summary: [summaryRow()],
    items: [],
    truncated: false,
  };
  assert.deepEqual(financeExceptionsResponseSchema.parse(response), response);
  assert.equal(
    financeExceptionsResponseSchema.safeParse({
      ...response,
      summary: [summaryRow({ unexpected: true })],
    }).success,
    false,
    "Other unknown response fields remain rejected",
  );
});

test("finance exceptions: known amount count is a required nonnegative integer", () => {
  for (const knownAmountCount of [undefined, -1, 0.5, null]) {
    assert.equal(
      financeExceptionsResponseSchema.safeParse({
        summary: [summaryRow({ knownAmountCount })],
        items: [],
        truncated: false,
      }).success,
      false,
    );
  }
});

test("finance exceptions: all-null values are unavailable", () => {
  const row = summarize(summaryRow(), [], true);
  assert.equal(row.unavailable, true);
  assert.equal(row.partial, false);
  assert.equal(row.amountIdr, 0);
  assert.equal(row.count, 2);
});

test("finance exceptions: a known zero amount remains available", () => {
  const row = summarize(summaryRow({ knownAmountCount: 2 }), [], true);
  assert.equal(row.unavailable, false);
  assert.equal(row.partial, false);
  assert.equal(row.amountIdr, 0);
});

test("finance exceptions: mixed known zero and null values are partial", () => {
  const row = summarize(summaryRow({ knownAmountCount: 1 }));
  assert.equal(row.unavailable, false);
  assert.equal(row.partial, true);
  assert.equal(row.amountIdr, 0);
});

test("finance exceptions: all-known totals stay exact despite truncated items", () => {
  const row = summarize(
    summaryRow({ count: 501, knownAmountCount: 501, amountIdr: 125000 }),
    [],
    true,
  );
  assert.equal(row.unavailable, false);
  assert.equal(row.partial, false);
  assert.equal(row.amountIdr, 125000);
  assert.equal(row.count, 501);
});

test("finance exceptions: mixed totals stay partial when returned items are all known", () => {
  const row = summarize(
    summaryRow({ count: 501, knownAmountCount: 500, amountIdr: 125000 }),
    [{ kind, amountIdr: 125000 }],
    true,
  );
  assert.equal(row.unavailable, false);
  assert.equal(row.partial, true);
  assert.equal(row.amountIdr, 125000);
});

test("finance exceptions: kinds with no rows keep an available zero", () => {
  for (const row of summarizeByKind([], [], false)) {
    assert.equal(row.count, 0);
    assert.equal(row.amountIdr, 0);
    assert.equal(row.unavailable, false);
    assert.equal(row.partial, false);
  }
});

test("finance exceptions: mock summaries carry the count of non-null amounts", async () => {
  const mock = findMock("GET", "/api/accounting/finance-exceptions");
  assert.ok(mock);
  const today = jakartaToday();
  const response = await mock.entry.handler({
    endpoint: mock.entry.endpoint,
    params: undefined,
    body: undefined,
    query: { from: addDays(today, -13), to: today },
    scenario: "normal",
  });
  financeExceptionsResponseSchema.parse(response);
  for (const row of response.summary) {
    const items = response.items.filter((item) => item.kind === row.kind);
    assert.equal(row.count, items.length);
    assert.equal(
      row.knownAmountCount,
      items.filter((item) => item.amountIdr !== null).length,
    );
    assert.equal(
      row.amountIdr,
      items.reduce((sum, item) => sum + (item.amountIdr ?? 0), 0),
    );
  }
});
