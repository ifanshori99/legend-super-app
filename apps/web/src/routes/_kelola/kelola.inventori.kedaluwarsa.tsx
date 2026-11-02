import { createFileRoute } from "@tanstack/react-router";
import { ExpiryPage } from "@/features/ws06-inventory/components/expiry-page";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  STOCK_LIST_LIMIT,
  isMockScenarioRequest,
} from "@/features/ws06-inventory/stock-lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import {
  batchesQuery,
  itemsQuery,
  locationsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/stock-queries";

// /kelola/inventori/kedaluwarsa — batches and FEFO order (PRD §16 "Batch &
// Kedaluwarsa").
export const Route = createFileRoute("/_kelola/kelola/inventori/kedaluwarsa")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            batchesQuery({
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
  component: ExpiryScreen,
});

function ExpiryScreen() {
  return (
    <InventoryPage active="expiry">
      <ExpiryPage />
    </InventoryPage>
  );
}
