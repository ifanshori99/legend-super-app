import { createFileRoute } from "@tanstack/react-router";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { PriceListsPage } from "@/features/ws03-menu/components/price-lists-page";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import { itemsQuery, priceListsQuery } from "@/features/ws03-menu/queries";

// /kelola/menu/harga — channel price lists with effective dates (PRD §8).
export const Route = createFileRoute("/_kelola/kelola/menu/harga")({
  beforeLoad: menuGuard(["menu.price.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(priceListsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
        ]),
  component: PricesScreen,
});

function PricesScreen() {
  return (
    <MenuPage active="prices">
      <PriceListsPage />
    </MenuPage>
  );
}
