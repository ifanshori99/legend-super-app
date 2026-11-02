import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { ItemsPage } from "@/features/ws06-inventory/components/items-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { itemsQuery, unitsQuery } from "@/features/ws06-inventory/queries";

// /kelola/inventori — item catalog (PRD §16 "Item Bahan & Satuan").
export const Route = createFileRoute("/_kelola/kelola/inventori/")({
  validateSearch: z.object({ category: z.string().max(50).optional() }),
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(unitsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
        ]),
  component: ItemsScreen,
});

function ItemsScreen() {
  const { category } = Route.useSearch();
  return (
    <InventoryPage active="items">
      <ItemsPage initialCategory={category} />
    </InventoryPage>
  );
}
