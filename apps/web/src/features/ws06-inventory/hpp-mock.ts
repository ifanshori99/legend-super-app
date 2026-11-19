// Mock mode for the HPP and food-cost reports (bead legend-5pe). Serves the
// shared Cafe Legend fixtures through the real contract, so every screen works
// with VITE_API_MOCK=true and ?mock=empty|error (docs/frontend.md "Mock mode").
// The route's beforeLoad imports this module: the shared handler glob only
// discovers features/*/mock.ts, and the inventory mock file belongs to the
// parallel stock beads.
//
// The handlers apply the same narrowing the API will: outlet scope (TEN-03),
// the optional menu item, and the report period. They never invent a row.
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import {
  cafeLegendInventoryFixtures,
  listFoodCostComparisons,
  listMenuCosts,
  listMenuEngineering,
  listRecipeCoverage,
} from "@starter/shared/inventory";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";
import { registerMenuNames } from "./hpp-lib.ts";

const fixtures = cafeLegendInventoryFixtures;

// The report rows carry menu ids only; the screens look names up in hpp-lib.
registerMenuNames(cafeLegendMenuFixtures.items);

/** A cost or coverage row is unique per menu item + variant + modifier. */
function itemScopeKey(row: {
  menuItemId: string;
  variantId: string | null;
  modifierId: string | null;
}): string {
  return `${row.menuItemId}:${row.variantId ?? "-"}:${row.modifierId ?? "-"}`;
}

registerMock(listMenuCosts, ({ query, scenario }) => {
  const rows = fixtures.menuCosts
    .filter((row) => row.outletId === query.outletId)
    .filter(
      (row) =>
        query.menuItemId === undefined || row.menuItemId === query.menuItemId,
    );
  return paginateFixture(rows, query, itemScopeKey, scenario);
});

registerMock(listFoodCostComparisons, ({ query, scenario }) => {
  // One row describes a closed business-date range. The period selector asks
  // for every row that overlaps its window, so a 30-day default still finds
  // the fixture's calendar-month comparison.
  const rows = fixtures.foodCostComparisons.filter(
    (row) =>
      row.outletId === query.outletId &&
      row.fromDate <= query.toDate &&
      row.toDate >= query.fromDate,
  );
  return paginateFixture(
    rows,
    query,
    (row) => `${row.outletId}:${row.fromDate}:${row.toDate}`,
    scenario,
  );
});

registerMock(listMenuEngineering, ({ query, scenario }) => {
  // The row schema has no business date: the classification is the result for
  // the period the server computed. Fixtures describe one demo period, so the
  // handler narrows by outlet only (the period is still validated input).
  const rows = fixtures.menuEngineering.filter(
    (row) => row.outletId === query.outletId,
  );
  return paginateFixture(rows, query, (row) => row.menuItemId, scenario);
});

registerMock(listRecipeCoverage, ({ query, scenario }) => {
  // A coverage row carries no brand id; the brand scope is the server's. The
  // fixture catalogue is the one demo brand and every item appears once.
  return paginateFixture(
    fixtures.recipeCoverage,
    query,
    itemScopeKey,
    scenario,
  );
});
