import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { SuggestionsPage } from "@/features/ws06-inventory/components/suggestions-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  STOCK_LIST_LIMIT,
  isMockScenarioRequest,
} from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import {
  balancesQuery,
  itemsQuery,
  locationsQuery,
  parLevelsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/queries";

// /kelola/inventori/saran — AI-08 purchase suggestions and the draft PR
// (PRD §16 "Par Level & Saran Pembelian", §4 Alur I step 1).
export const Route = createFileRoute("/_kelola/kelola/inventori/saran")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            parLevelsQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: STOCK_LIST_LIMIT,
            }),
          ),
          context.queryClient.ensureQueryData(
            balancesQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: STOCK_LIST_LIMIT,
            }),
          ),
          context.queryClient.ensureQueryData(
            itemsQuery({ limit: STOCK_LIST_LIMIT }),
          ),
          context.queryClient.ensureQueryData(
            locationsQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: STOCK_LIST_LIMIT,
            }),
          ),
          context.queryClient.ensureQueryData(
            unitsQuery({ limit: STOCK_LIST_LIMIT }),
          ),
        ]),
  component: SuggestionsScreen,
});

function SuggestionsScreen() {
  return (
    <InventoryPage active="suggestions">
      <SuggestionsPage />
    </InventoryPage>
  );
}
