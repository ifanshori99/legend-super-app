import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { StockCardPage } from "@/features/ws06-inventory/components/stock-card-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  STOCK_LIST_LIMIT,
  isMockScenarioRequest,
} from "@/features/ws06-inventory/stock-lib";
import {
  itemsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/stock-queries";

// /kelola/inventori/stok — stock card / ledger (PRD §16 "Kartu Stok
// Append-only", INV-01).
export const Route = createFileRoute("/_kelola/kelola/inventori/stok")({
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
  component: StockCardScreen,
});

function StockCardScreen() {
  return (
    <InventoryPage active="stock">
      <StockCardPage />
    </InventoryPage>
  );
}
