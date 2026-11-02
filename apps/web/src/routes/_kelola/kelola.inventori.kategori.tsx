import { createFileRoute } from "@tanstack/react-router";
import { CategoriesPage } from "@/features/ws06-inventory/components/categories-page";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { itemsQuery, unitsQuery } from "@/features/ws06-inventory/queries";

// /kelola/inventori/kategori — item categories with counts (PRD §16).
export const Route = createFileRoute("/_kelola/kelola/inventori/kategori")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(unitsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
        ]),
  component: CategoriesScreen,
});

function CategoriesScreen() {
  return (
    <InventoryPage active="categories">
      <CategoriesPage />
    </InventoryPage>
  );
}
