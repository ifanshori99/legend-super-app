import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { WastePage } from "@/features/ws06-inventory/components/waste-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  isMockScenarioRequest,
  LIST_LIMIT,
} from "@/features/ws06-inventory/lib";
import { menuQuery } from "@/features/ws06-inventory/opname-queries";
import { itemsQuery, unitsQuery } from "@/features/ws06-inventory/queries";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/waste — waste and spoilage log (PRD §16 "Waste &
// Spoilage"). Recording needs inventory.waste.record; viewing needs the
// area's inventory.stock.view.
export const Route = createFileRoute("/_kelola/kelola/inventori/waste")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            itemsQuery({ limit: LIST_LIMIT }),
          ),
          context.queryClient.ensureQueryData(
            menuQuery({ limit: LIST_LIMIT, status: "active" }),
          ),
          context.queryClient.ensureQueryData(
            unitsQuery({ limit: LIST_LIMIT }),
          ),
        ]),
  component: WasteScreen,
});

function WasteScreen() {
  const { access } = Route.useRouteContext();
  return (
    <InventoryPage active="waste">
      <WastePage canRecord={holdsAny(access, ["inventory.waste.record"])} />
    </InventoryPage>
  );
}
