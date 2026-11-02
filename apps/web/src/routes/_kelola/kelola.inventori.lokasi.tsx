import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { LocationsPage } from "@/features/ws06-inventory/components/locations-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import {
  balancesQuery,
  locationsQuery,
} from "@/features/ws06-inventory/queries";

// /kelola/inventori/lokasi — storage locations (PRD §16 "Lokasi Stok").
export const Route = createFileRoute("/_kelola/kelola/inventori/lokasi")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            locationsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
          context.queryClient.ensureQueryData(
            balancesQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
        ]),
  component: LocationsScreen,
});

function LocationsScreen() {
  return (
    <InventoryPage active="locations">
      <LocationsPage />
    </InventoryPage>
  );
}
