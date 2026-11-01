import { createFileRoute } from "@tanstack/react-router";
import { CategoriesPage } from "@/features/ws03-menu/components/categories-page";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import { categoriesQuery, itemsQuery } from "@/features/ws03-menu/queries";

// /kelola/menu/kategori — categories and their display order (PRD §8).
export const Route = createFileRoute("/_kelola/kelola/menu/kategori")({
  beforeLoad: menuGuard(["menu.item.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(categoriesQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
        ]),
  component: CategoriesScreen,
});

function CategoriesScreen() {
  return (
    <MenuPage active="categories">
      <CategoriesPage />
    </MenuPage>
  );
}
