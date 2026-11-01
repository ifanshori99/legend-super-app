import { createFileRoute } from "@tanstack/react-router";
import { AvailabilityPage } from "@/features/ws03-menu/components/availability-page";
import { MenuPage } from "@/features/ws03-menu/components/menu-shell";
import { menuGuard } from "@/features/ws03-menu/guard";
import { isMockScenarioRequest } from "@/features/ws03-menu/lib";
import {
  availabilityQuery,
  itemsQuery,
  stationsQuery,
} from "@/features/ws03-menu/queries";

// /kelola/menu/ketersediaan — schedules, daily limits, 86 (PRD §8).
export const Route = createFileRoute("/_kelola/kelola/menu/ketersediaan")({
  beforeLoad: menuGuard(["menu.item.view"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            availabilityQuery({ limit: 100 }),
          ),
          context.queryClient.ensureQueryData(itemsQuery({ limit: 100 })),
          context.queryClient.ensureQueryData(stationsQuery({ limit: 100 })),
        ]),
  component: AvailabilityScreen,
});

function AvailabilityScreen() {
  return (
    <MenuPage active="availability">
      <AvailabilityPage />
    </MenuPage>
  );
}
