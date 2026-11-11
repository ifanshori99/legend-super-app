// legend-wjz1: negative storage ranges on the prep label read clearly.
// Contract (coordinator correction, follows the approved mockup): pure
// `formatTempRange(min, max)` in operations-food-safety/logic.ts, minus sign is
// U+2212, joined by " hingga ".
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTempRange } from "../apps/web/src/features/operations-food-safety/logic.ts";

test("a freezer range uses the true minus sign on both bounds", () => {
  assert.equal(formatTempRange(-22, -16), "−22 °C hingga −16 °C");
});

test("a chiller range has no sign", () => {
  assert.equal(formatTempRange(0, 4), "0 °C hingga 4 °C");
});

test("a range crossing zero signs only the negative bound", () => {
  assert.equal(formatTempRange(-2, 4), "−2 °C hingga 4 °C");
});

test("the label never contains a hyphen-minus in a temperature", () => {
  for (const [min, max] of [
    [-22, -16],
    [-2, 4],
    [-18, -12],
  ])
    assert.doesNotMatch(formatTempRange(min, max), /-/);
});
