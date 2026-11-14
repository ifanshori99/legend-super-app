import { createFileRoute } from "@tanstack/react-router";
import { KitchenConfigPage } from "@/features/ws04-kitchen-config/components/kitchen-config-page";
import { StationConfigPage } from "@/features/ws04-kitchen-config/components/station-config-page";
import { kitchenConfigGuard } from "@/features/ws04-kitchen-config/guard";

// /kelola/dapur/stasiun — KDS tab order, station on/off and print fallback per
// station (PRD §3 F12 "KDS per Stasiun", bead legend-sonf).
export const Route = createFileRoute("/_kelola/kelola/dapur_/stasiun")({
  beforeLoad: kitchenConfigGuard(["kds.station.manage"]),
  component: StationsScreen,
});

function StationsScreen() {
  return (
    <KitchenConfigPage active="stations">
      <StationConfigPage />
    </KitchenConfigPage>
  );
}
