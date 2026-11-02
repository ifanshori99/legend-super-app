import assert from "node:assert/strict";
import { test } from "node:test";
import { purchaseSuggestions } from "../apps/web/src/features/ws06-purchasing/suggestions.ts";

// PRD §16 / AI-08: temporary par basis, not a demand forecast.
test("AI-08 suggests the precise shortfall to par maximum only below minimum", () => {
  const items = [{ id: "milk", parMin: "5.0000", parMax: "10.0000" }];
  const balances = [
    { inventoryItemId: "milk", locationId: "bar", quantity: "3.1250" },
  ];
  const suggestions = purchaseSuggestions({ items, balances, parLevels: [] });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].suggestedQty, "6.8750");
  assert.equal(
    purchaseSuggestions({
      items,
      balances: [{ ...balances[0], quantity: "5.0000" }],
      parLevels: [],
    }).length,
    0,
  );
});

test("AI-08 uses location override and includes explicit pairs with zero stock", () => {
  const items = [{ id: "milk", parMin: "5.0000", parMax: "10.0000" }];
  const parLevels = [
    {
      inventoryItemId: "milk",
      locationId: "bar",
      parMin: "2.0000",
      parMax: "4.0000",
    },
  ];
  assert.equal(
    purchaseSuggestions({ items, balances: [], parLevels })[0].suggestedQty,
    "4.0000",
  );
  assert.equal(
    purchaseSuggestions({
      items,
      balances: [
        { inventoryItemId: "milk", locationId: "bar", quantity: "3.0000" },
      ],
      parLevels,
    }).length,
    0,
  );
});
