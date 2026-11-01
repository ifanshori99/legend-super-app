import { createFileRoute } from "@tanstack/react-router";
import { ItemListPage } from "@/features/ws03-menu/components/item-list-page";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import {
  availabilityQuery,
  categoriesQuery,
  itemsQuery,
  priceListsQuery,
  stationsQuery,
} from "@/features/ws03-menu/queries";

// /kelola/menu — menu items list (PRD §8 "Struktur Menu", "Konten Menu").
export const Route = createFileRoute("/_kelola/kelola/menu/")({
  beforeLoad: menuGuard(["menu.item.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(categoriesQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(stationsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(
            availabilityQuery({ limit: 100 }),
          ),
          context.queryClient.ensureQueryData(priceListsQuery({ limit: 100 })),
        ]),
  component: ItemsScreen,
});

function ItemsScreen() {
  return (
    <MenuPage active="items">
      <ItemListPage />
    </MenuPage>
  );
}
