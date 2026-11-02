import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { UnitsPage } from "@/features/ws06-inventory/components/units-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { itemsQuery, unitsQuery } from "@/features/ws06-inventory/queries";

// /kelola/inventori/satuan — unit catalog and per-item conversions (PRD §16).
export const Route = createFileRoute("/_kelola/kelola/inventori/satuan")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(unitsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
        ]),
  component: UnitsScreen,
});

function UnitsScreen() {
  return (
    <InventoryPage active="units">
      <UnitsPage />
    </InventoryPage>
  );
}
