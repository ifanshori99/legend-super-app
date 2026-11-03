import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { HppPage } from "@/features/ws06-inventory/components/hpp-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  HPP_LIST_LIMIT,
  defaultPeriod,
} from "@/features/ws06-inventory/hpp-lib";
import {
  coverageQuery,
  engineeringQuery,
  foodCostQuery,
  menuCostsQuery,
} from "@/features/ws06-inventory/hpp-queries";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { isMockScenarioRequest } from "@/features/ws06-inventory/stock-lib";

// /kelola/inventori/hpp — HPP per menu, actual vs theoretical food cost, menu
// engineering, and recipe completeness (PRD v1.7 §17, F17).
export const Route = createFileRoute("/_kelola/kelola/inventori/hpp")({
  beforeLoad: async (args) => {
    // The HPP handlers live in hpp-mock.ts so parallel inventory beads never
    // edit one mock file. The mock runtime discovers features/*/mock.ts only,
    // so load this module before the first query; the branch compiles out of a
    // normal build (same workaround as the recipe routes).
    if (import.meta.env.VITE_API_MOCK === "true")
      await import("@/features/ws06-inventory/hpp-mock.ts");
    inventoryGuard(["inventory.stock.view"])(args);
  },
  loader: ({ context, location }) => {
    // The mock scenario lives in the browser, so a server prefetch would hide
    // the empty/error state the URL asks for (stock-lib helper).
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    const period = defaultPeriod();
    return Promise.all([
      context.queryClient.ensureQueryData(
        menuCostsQuery({
          outletId: INVENTORY_OUTLET_ID,
          limit: HPP_LIST_LIMIT,
        }),
      ),
      context.queryClient.ensureQueryData(
        foodCostQuery({
          outletId: INVENTORY_OUTLET_ID,
          ...period,
          limit: HPP_LIST_LIMIT,
        }),
      ),
      context.queryClient.ensureQueryData(
        engineeringQuery({
          outletId: INVENTORY_OUTLET_ID,
          ...period,
          limit: HPP_LIST_LIMIT,
        }),
      ),
      context.queryClient.ensureQueryData(
        coverageQuery({ limit: HPP_LIST_LIMIT }),
      ),
    ]);
  },
  component: HppScreen,
});

function HppScreen() {
  return (
    <InventoryPage active="hpp">
      <HppPage />
    </InventoryPage>
  );
}
