import { createFileRoute } from "@tanstack/react-router";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { StationsPage } from "@/features/ws03-menu/components/stations-page";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import { itemsQuery, stationsQuery } from "@/features/ws03-menu/queries";

// /kelola/menu/stasiun — production stations and targets (PRD §8 "Routing").
export const Route = createFileRoute("/_kelola/kelola/menu/stasiun")({
  beforeLoad: menuGuard(["menu.item.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(stationsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
        ]),
  component: StationsScreen,
});

function StationsScreen() {
  return (
    <MenuPage active="stations">
      <StationsPage />
    </MenuPage>
  );
}
