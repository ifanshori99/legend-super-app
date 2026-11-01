import { createFileRoute } from "@tanstack/react-router";
import { CombosPage } from "@/features/ws03-menu/components/combos-page";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import {
  combosQuery,
  itemsQuery,
  priceListsQuery,
} from "@/features/ws03-menu/queries";

// /kelola/menu/paket — combos, contents and revenue allocation (PRD §8).
export const Route = createFileRoute("/_kelola/kelola/menu/paket")({
  beforeLoad: menuGuard(["menu.price.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(combosQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(priceListsQuery({ limit: 100 })),
        ]),
  component: CombosScreen,
});

function CombosScreen() {
  return (
    <MenuPage active="combos">
      <CombosPage />
    </MenuPage>
  );
}
