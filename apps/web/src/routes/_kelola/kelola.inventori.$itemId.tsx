import { createFileRoute } from "@tanstack/react-router";
import { InventoryPage } from "@/features/ws06-inventory/components/inventory-shell";
import { ItemEditorPage } from "@/features/ws06-inventory/components/item-editor-page";
import { inventoryGuard } from "@/features/ws06-inventory/guard";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import {
  alternatesQuery,
  conversionsQuery,
  itemQuery,
  itemsQuery,
  unitsQuery,
} from "@/features/ws06-inventory/queries";

// /kelola/inventori/$itemId — one item's identity, conversions and
// alternates. `baru` opens the create form.
export const Route = createFileRoute("/_kelola/kelola/inventori/$itemId")({
  beforeLoad: inventoryGuard(["inventory.stock.view"]),
  loader: ({ context, location, params }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    const common = [
      context.queryClient.ensureQueryData(unitsQuery({ limit: 100 })),
      context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
    ];
    if (params.itemId === "baru") return Promise.all(common);
    return Promise.all([
      ...common,
      context.queryClient.ensureQueryData(itemQuery({ itemId: params.itemId })),
      context.queryClient.ensureQueryData(
        conversionsQuery({ itemId: params.itemId }),
      ),
      context.queryClient.ensureQueryData(
        alternatesQuery({ itemId: params.itemId }),
      ),
    ]);
  },
  component: EditorScreen,
});

function EditorScreen() {
  const { itemId } = Route.useParams();
  return (
    <InventoryPage active="items">
      <ItemEditorPage itemId={itemId} />
    </InventoryPage>
  );
}
