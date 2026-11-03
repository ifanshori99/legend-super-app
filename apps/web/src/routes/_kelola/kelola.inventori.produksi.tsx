import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { ProductionPage } from "@/features/ws06-inventory/components/production-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  isMockScenarioRequest,
  LIST_LIMIT,
} from "@/features/ws06-inventory/lib";
import { unitsQuery } from "@/features/ws06-inventory/queries";
import { RECIPE_BRAND_ID } from "@/features/ws06-inventory/recipe-lib";
import {
  productionOrdersQuery,
  recipesQuery,
} from "@/features/ws06-inventory/recipe-queries";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/produksi — production batch orders for semi-finished
// recipes (PRD §17 "Produksi Batch", §3 F17). Viewing needs
// inventory.stock.view; creating and transitioning need recipe.manage.
export const Route = createFileRoute("/_kelola/kelola/inventori/produksi")({
  // recipe-mock.ts is loaded by the mock runtime's features/*/*-mock.ts glob.
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            productionOrdersQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: LIST_LIMIT,
            }),
          ),
          context.queryClient.ensureQueryData(
            recipesQuery({ brandId: RECIPE_BRAND_ID, limit: LIST_LIMIT }),
          ),
          context.queryClient.ensureQueryData(
            unitsQuery({ limit: LIST_LIMIT }),
          ),
        ]),
  component: ProductionScreen,
});

function ProductionScreen() {
  const { access } = Route.useRouteContext();
  return (
    <InventoryPage active="production">
      <ProductionPage canManage={holdsAny(access, ["recipe.manage"])} />
    </InventoryPage>
  );
}
