// Execute the form's actual nested validation predicate, with its real
// date helpers. Keeping the predicate in the component must not force tests
// to duplicate it or reimplement its DST decision.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { calculatePrepUseBy } from "../packages/shared/src/operations/index.ts";
import {
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from "../apps/web/src/features/operations-food-safety/logic.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = ts.createSourceFile(
  "label-prep-screen.tsx",
  readFileSync(
    new URL(
      "../apps/web/src/features/operations-food-safety/components/label-prep-screen.tsx",
      import.meta.url,
    ),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let predicate;
function findPredicate(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "validate")
    predicate = node;
  ts.forEachChild(node, findPredicate);
}
findPredicate(source);
assert.ok(
  predicate,
  "the prep form must expose its current validation predicate",
);
const compiled = ts.transpileModule(
  `export function validateForm(values, fromDateTimeLocalValue) {
    const { itemId, setting, shelfLifeChanged, settingsResult, selectedBatch,
      producedAt, useBy, calculatedUseBy, clock, t } = values;
    ${predicate.getText(source)}
    return validate();
  }`,
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const { validateForm } = await import(
  `data:text/javascript,${encodeURIComponent(compiled)}`
);

test("legend-do1o the actual prep form accepts an expiry in the repeated DST hour from its calculated instant", () => {
  const timeZone = "America/New_York";
  const producedAt = "2030-11-03T01:30";
  const producedIso = fromDateTimeLocalValue(producedAt, timeZone);
  assert.equal(producedIso, "2030-11-03T05:30:00.000Z");
  for (const [minutes, expectedIso, expectedDisplay] of [
    [30, "2030-11-03T06:00:00.000Z", "2030-11-03T01:00"],
    [60, "2030-11-03T06:30:00.000Z", "2030-11-03T01:30"],
  ]) {
    const calculatedUseBy = calculatePrepUseBy(producedIso, minutes);
    assert.equal(calculatedUseBy, expectedIso);
    const useBy = toDateTimeLocalValue(new Date(calculatedUseBy), timeZone);
    assert.equal(useBy, expectedDisplay);
    const result = validateForm(
      {
        itemId: "prep-item",
        setting: { shelfLifeMinutes: minutes },
        shelfLifeChanged: false,
        settingsResult: { isError: false, isFetching: false },
        selectedBatch: { inventoryItemId: "prep-item" },
        producedAt,
        useBy,
        calculatedUseBy,
        clock: { timeZone },
        t: (key) => key,
      },
      fromDateTimeLocalValue,
    );
    assert.deepEqual(result.errors, {});
    assert.equal(result.producedIso, producedIso);
    assert.equal(result.useByIso, expectedIso);
  }
});
