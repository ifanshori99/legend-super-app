// legend-135b4: the receipt/kuitansi/invoice document line after a kitchen swap
// on a completed POS order. The replacement line is recorded at unit price 0
// (the customer already paid the final order), the old line stays live.
//
// Assumptions where the brief is silent:
// - The line field is `swapRole`, "none" | "replacement", default "none".
// - A positive-priced line may also carry swapRole "replacement" (only the
//   price rule is tied to the role, not the other way round).
// - Document totals stay valid because the replacement adds a 0 line total.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as pos from "../packages/shared/src/pos/index.ts";

const parsed = pos.posFixtureSchema.parse(pos.cafeLegendPosFixtures);
const documentFixture = parsed.receiptDocuments[0];
const baseLine = documentFixture.items[0];
assert.ok(baseLine.unitPriceIdr > 0, "fixture line has a positive price");

const freeLine = (overrides = {}) => ({
  ...baseLine,
  unitPriceIdr: 0,
  modifiersTotalIdr: 0,
  lineTotalIdr: 0,
  ...overrides,
});

test("a normal line with unit price 0 is still rejected", () => {
  assert.equal(pos.posDocumentLineSchema.safeParse(freeLine()).success, false);
  assert.equal(
    pos.posDocumentLineSchema.safeParse(freeLine({ swapRole: "none" })).success,
    false,
  );
});

test("a replacement line with unit price 0 is accepted and keeps its role", () => {
  const result = pos.posDocumentLineSchema.safeParse(
    freeLine({ name: "Pengganti: Teh Tawar", swapRole: "replacement" }),
  );
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data.swapRole, "replacement");
  assert.equal(result.data.unitPriceIdr, 0);
});

test("a line without swapRole defaults to none", () => {
  const result = pos.posDocumentLineSchema.parse(baseLine);
  assert.equal(result.swapRole, "none");
});

test("an unknown swapRole is rejected", () => {
  for (const swapRole of ["replaced", "other", ""])
    assert.equal(
      pos.posDocumentLineSchema.safeParse({ ...baseLine, swapRole }).success,
      false,
      `swapRole ${JSON.stringify(swapRole)}`,
    );
});

test("a normal line with a positive price is accepted as before", () => {
  assert.equal(pos.posDocumentLineSchema.safeParse(baseLine).success, true);
});

test("a receipt document with a free replacement line keeps valid totals", () => {
  const withSwap = {
    ...documentFixture,
    items: [
      ...documentFixture.items,
      freeLine({ name: "Pengganti: Teh Tawar", swapRole: "replacement" }),
    ],
  };
  const result = pos.receiptDocumentSchema.safeParse(withSwap);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data.subtotalIdr, documentFixture.subtotalIdr);
});

test("a receipt document with a free normal line is rejected", () => {
  const result = pos.receiptDocumentSchema.safeParse({
    ...documentFixture,
    items: [...documentFixture.items, freeLine({ name: "Gratis" })],
  });
  assert.equal(result.success, false);
});
