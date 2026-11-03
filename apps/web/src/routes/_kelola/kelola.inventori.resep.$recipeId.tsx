import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { RecipeEditorPage } from "@/features/ws06-inventory/components/recipe-editor-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import {
  isMockScenarioRequest,
  LIST_LIMIT,
} from "@/features/ws06-inventory/lib";
import {
  balancesQuery,
  itemsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/queries";
import {
  recipeQuery,
  recipesQuery,
} from "@/features/ws06-inventory/recipe-queries";
import { RECIPE_BRAND_ID } from "@/features/ws06-inventory/recipe-lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { ApiError } from "@/lib/api/errors";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/inventori/resep/$recipeId — the multi-level BOM editor (PRD §17
// "Resep Bertingkat", owner Q19/Q20). Viewing needs inventory.stock.view;
// saving a new version needs recipe.manage and is hidden otherwise.
export const Route = createFileRoute(
  "/_kelola/kelola/inventori/resep/$recipeId",
)({
  // recipe-mock.ts is loaded by the mock runtime's features/*/*-mock.ts glob.
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: async ({ context, location, params }) => {
    if (isMockScenarioRequest(location.searchStr)) return;
    try {
      await Promise.all([
        context.queryClient.ensureQueryData(
          recipeQuery({ recipeId: params.recipeId }),
        ),
        context.queryClient.ensureQueryData(
          recipesQuery({ brandId: RECIPE_BRAND_ID, limit: LIST_LIMIT }),
        ),
        context.queryClient.ensureQueryData(itemsQuery({ limit: LIST_LIMIT })),
        context.queryClient.ensureQueryData(unitsQuery({ limit: LIST_LIMIT })),
        context.queryClient.ensureQueryData(
          balancesQuery({ outletId: INVENTORY_OUTLET_ID, limit: LIST_LIMIT }),
        ),
      ]);
    } catch (error) {
      // A stale link lands on the page's not-found state; only a genuine
      // server failure becomes the route error boundary.
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  },
  component: RecipeEditorScreen,
});

function RecipeEditorScreen() {
  const { recipeId } = Route.useParams();
  const { access } = Route.useRouteContext();
  return (
    <InventoryPage active="recipes">
      <RecipeEditorPage
        recipeId={recipeId}
        canManage={holdsAny(access, ["recipe.manage"])}
        canViewCost={holdsAny(access, [
          "recipe.cost.view",
          "inventory.cost.view",
        ])}
      />
    </InventoryPage>
  );
}
