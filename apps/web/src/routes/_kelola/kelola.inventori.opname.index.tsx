import { createFileRoute } from "@tanstack/react-router";
import { CountsPage } from "@/features/ws06-inventory/components/counts-page";
import { OpnamePage } from "@/features/ws06-inventory/components/opname-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  countsQuery,
  locationsQuery,
} from "@/features/ws06-inventory/queries";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { isMockScenarioRequest } from "@/features/ws06-inventory/opname-lib";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/opname — stock-count sessions (PRD §16 "Stok Opname",
// Alur J). The list itself needs inventory.stock.view; starting a count needs
// inventory.opname.count and is hidden otherwise.
export const Route = createFileRoute("/_kelola/kelola/inventori/opname/")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            countsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
          context.queryClient.ensureQueryData(
            locationsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
        ]),
  component: CountsScreen,
});

function CountsScreen() {
  const { access } = Route.useRouteContext();
  return (
    <OpnamePage active="counts">
      <CountsPage canCount={holdsAny(access, ["inventory.opname.count"])} />
    </OpnamePage>
  );
}
