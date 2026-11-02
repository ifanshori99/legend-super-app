import { createFileRoute } from "@tanstack/react-router";
import { BalancesPage } from "@/features/ws06-inventory/components/balances-page";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  STOCK_LIST_LIMIT,
  isMockScenarioRequest,
} from "@/features/ws06-inventory/stock-lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import {
  balancesQuery,
  batchesQuery,
  itemsQuery,
  locationsQuery,
  parLevelsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/stock-queries";

// /kelola/inventori/saldo — balances per location, par levels and critical
// alerts (PRD §16 "Lokasi Stok", "Metode Biaya", "Par Level").
export const Route = createFileRoute("/_kelola/kelola/inventori/saldo")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            balancesQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: STOCK_LIST_LIMIT,
            }),
          ),
          context.queryClient.ensureQueryData(
            parLevelsQuery({
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
          context.queryClient.ensureQueryData(
            batchesQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: STOCK_LIST_LIMIT,
            }),
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
