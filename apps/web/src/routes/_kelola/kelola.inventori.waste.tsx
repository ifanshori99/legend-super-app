import { createFileRoute } from "@tanstack/react-router";
import { OpnamePage } from "@/features/ws06-inventory/components/opname-shell";
import { WastePage } from "@/features/ws06-inventory/components/waste-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/opname-lib";
import {
  itemsQuery,
  locationsQuery,
  menuQuery,
  unitsQuery,
  wasteQuery,
} from "@/features/ws06-inventory/queries";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/waste — waste and spoilage log (PRD §16 "Waste &
// Spoilage"). Recording needs inventory.waste.record; viewing needs the
// area's inventory.stock.view.
export const Route = createFileRoute("/_kelola/kelola/inventori/waste")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            wasteQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: 100,
            }),
          ),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(
            menuQuery({ limit: 100, status: "active" }),
          ),
          context.queryClient.ensureQueryData(unitsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(
            locationsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
        ]),
  component: WasteScreen,
});

function WasteScreen() {
  const { access } = Route.useRouteContext();
  return (
    <OpnamePage active="waste">
      <WastePage canRecord={holdsAny(access, ["inventory.waste.record"])} />
    </OpnamePage>
  );
}
