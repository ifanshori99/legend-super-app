import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { StockCardPage } from "@/features/ws06-inventory/components/stock-card-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  STOCK_LIST_LIMIT,
  isMockScenarioRequest,
} from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import {
  batchesQuery,
  itemsQuery,
  ledgerQuery,
  locationsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/queries";

// /kelola/inventori/stok — stock card / ledger (PRD §16 "Kartu Stok
// Append-only", INV-01).
export const Route = createFileRoute("/_kelola/kelola/inventori/stok")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            ledgerQuery({
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
            batchesQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: STOCK_LIST_LIMIT,
            }),
          ),
          context.queryClient.ensureQueryData(
            unitsQuery({ limit: STOCK_LIST_LIMIT }),
          ),
        ]),
  component: StockCardScreen,
});

function StockCardScreen() {
  return (
    <InventoryPage active="stock">
      <StockCardPage />
    </InventoryPage>
  );
}
