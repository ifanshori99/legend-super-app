import { createFileRoute } from "@tanstack/react-router";
import { CountsPage } from "@/features/ws06-inventory/components/counts-page";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  isMockScenarioRequest,
  LIST_LIMIT,
} from "@/features/ws06-inventory/lib";
import { countsQuery } from "@/features/ws06-inventory/opname-queries";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { locationsQuery } from "@/features/ws06-inventory/queries";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/opname — stock-count sessions (PRD §16 "Stok Opname",
// Alur J). The list needs inventory.stock.view; starting a count needs
// inventory.opname.count and is hidden otherwise.
export const Route = createFileRoute("/_kelola/kelola/inventori/opname/")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            countsQuery({ outletId: INVENTORY_OUTLET_ID, limit: LIST_LIMIT }),
          ),
          context.queryClient.ensureQueryData(
            locationsQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: LIST_LIMIT,
            }),
          ),
        ]),
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
