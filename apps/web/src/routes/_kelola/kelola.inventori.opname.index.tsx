import { createFileRoute } from "@tanstack/react-router";
import { CountsPage } from "@/features/ws06-inventory/components/counts-page";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/opname — stock-count sessions (PRD §16 "Stok Opname",
// Alur J). The list needs inventory.stock.view; starting a count needs
// inventory.opname.count and is hidden otherwise.
export const Route = createFileRoute("/_kelola/kelola/inventori/opname/")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
  component: CountsScreen,
});

function CountsScreen() {
  const { access } = Route.useRouteContext();
  return (
    <InventoryPage active="opname">
      <CountsPage canCount={holdsAny(access, ["inventory.opname.count"])} />
    </InventoryPage>
  );
}
