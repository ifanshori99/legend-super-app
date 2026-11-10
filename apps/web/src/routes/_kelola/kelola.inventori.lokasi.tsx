import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { LocationsPage } from "@/features/ws06-inventory/components/locations-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";

// /kelola/inventori/lokasi — storage locations (PRD §16 "Lokasi Stok").
export const Route = createFileRoute("/_kelola/kelola/inventori/lokasi")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
  component: LocationsScreen,
});

function LocationsScreen() {
  return (
    <InventoryPage active="locations">
      <LocationsPage />
    </InventoryPage>
  );
}
