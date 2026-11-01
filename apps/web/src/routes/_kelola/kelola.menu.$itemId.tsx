import { createFileRoute } from "@tanstack/react-router";
import { ItemEditorPage } from "@/features/ws03-menu/components/item-editor-page";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import {
  categoriesQuery,
  itemQuery,
  stationsQuery,
} from "@/features/ws03-menu/queries";

// /kelola/menu/$itemId — one item's content, variants and modifiers.
// `baru` opens the create form.
export const Route = createFileRoute("/_kelola/kelola/menu/$itemId")({
  beforeLoad: menuGuard(["menu.item.view"]),
  loader: ({ context, location, params }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(categoriesQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(stationsQuery({ limit: 100 })),
          params.itemId === "baru"
            ? undefined
            : context.queryClient.ensureQueryData(
                itemQuery({ itemId: params.itemId }),
              ),
        ]),
  component: EditorScreen,
});

function EditorScreen() {
  const { itemId } = Route.useParams();
  return (
    <MenuPage active="items">
      <ItemEditorPage itemId={itemId} />
    </MenuPage>
  );
}
