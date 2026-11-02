import { createFileRoute } from "@tanstack/react-router";
import { CapacityPage } from "@/features/ws04-kitchen-config/components/capacity-page";
import { KitchenConfigPage } from "@/features/ws04-kitchen-config/components/kitchen-config-page";
import { kitchenConfigGuard } from "@/features/ws04-kitchen-config/guard";

// /kelola/dapur — kitchen stations, capacity per window and pacing (PRD §3 F12
// "KDS per Stasiun", "Order Pacing"). The kelola layout owns the shell, the
// padat density and the management guard; this page adds the kitchen permission.
export const Route = createFileRoute("/_kelola/kelola/dapur")({
  beforeLoad: kitchenConfigGuard(["kds.station.manage"]),
  component: CapacityScreen,
});

function CapacityScreen() {
  return (
    <KitchenConfigPage active="capacity">
      <CapacityPage />
    </KitchenConfigPage>
  );
}
