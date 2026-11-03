import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { RecipeListPage } from "@/features/ws06-inventory/components/recipe-list-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  isMockScenarioRequest,
  LIST_LIMIT,
} from "@/features/ws06-inventory/lib";
import { itemsQuery, unitsQuery } from "@/features/ws06-inventory/queries";
import { RECIPE_BRAND_ID } from "@/features/ws06-inventory/recipe-lib";
import { recipesQuery } from "@/features/ws06-inventory/recipe-queries";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/resep — versioned recipes and their theoretical HPP
// (PRD §17 "Resep Bertingkat", §3 F17). Viewing needs inventory.stock.view;
// creating and editing need recipe.manage and are hidden otherwise.
export const Route = createFileRoute("/_kelola/kelola/inventori/resep/")({
  // Recipe handlers live in recipe-mock.ts, which the mock runtime's
  // `features/*/*-mock.ts` glob loads with the other handler modules.
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            recipesQuery({ brandId: RECIPE_BRAND_ID, limit: LIST_LIMIT }),
          ),
          context.queryClient.ensureQueryData(
            itemsQuery({ limit: LIST_LIMIT }),
          ),
          context.queryClient.ensureQueryData(
            unitsQuery({ limit: LIST_LIMIT }),
          ),
        ]),
  component: RecipeListScreen,
});

function RecipeListScreen() {
  const { access } = Route.useRouteContext();
  return (
    <InventoryPage active="recipes">
      <RecipeListPage
        canManage={holdsAny(access, ["recipe.manage"])}
        canViewCost={holdsAny(access, [
          "recipe.cost.view",
          "inventory.cost.view",
        ])}
      />
    </InventoryPage>
  );
}
