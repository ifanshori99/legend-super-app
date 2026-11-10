import { createFileRoute } from "@tanstack/react-router";
import { BalancesPage } from "@/features/ws06-inventory/components/balances-page";
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

// /kelola/inventori/saldo — balances per location, par levels and critical
// alerts (PRD §16 "Lokasi Stok", "Metode Biaya", "Par Level").
export const Route = createFileRoute("/_kelola/kelola/inventori/saldo")({
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
  component: BalancesScreen,
});

function BalancesScreen() {
  return (
    <InventoryPage active="balances">
      <BalancesPage />
    </InventoryPage>
  );
}
