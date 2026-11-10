import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { SuggestionsPage } from "@/features/ws06-inventory/components/suggestions-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  STOCK_LIST_LIMIT,
  isMockScenarioRequest,
} from "@/features/ws06-inventory/stock-lib";
import {
  itemsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/stock-queries";

// /kelola/inventori/saran — AI-08 purchase suggestions and the draft PR
// (PRD §16 "Par Level & Saran Pembelian", §4 Alur I step 1).
export const Route = createFileRoute("/_kelola/kelola/inventori/saran")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            itemsQuery({ limit: STOCK_LIST_LIMIT }),
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
