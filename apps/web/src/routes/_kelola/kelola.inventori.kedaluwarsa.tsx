import { createFileRoute } from "@tanstack/react-router";
import { ExpiryPage } from "@/features/ws06-inventory/components/expiry-page";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  STOCK_LIST_LIMIT,
  isMockScenarioRequest,
} from "@/features/ws06-inventory/stock-lib";
import {
  itemsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/stock-queries";

// /kelola/inventori/kedaluwarsa — batches and FEFO order (PRD §16 "Batch &
// Kedaluwarsa").
export const Route = createFileRoute("/_kelola/kelola/inventori/kedaluwarsa")({
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
  component: ExpiryScreen,
});

function ExpiryScreen() {
  return (
    <InventoryPage active="expiry">
      <ExpiryPage />
    </InventoryPage>
  );
}
