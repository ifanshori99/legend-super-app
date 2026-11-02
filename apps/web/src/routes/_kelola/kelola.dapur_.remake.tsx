import { createFileRoute } from "@tanstack/react-router";
import { KitchenConfigPage } from "@/features/ws04-kitchen-config/components/kitchen-config-page";
import { RemakeCompPage } from "@/features/ws04-kitchen-config/components/remake-comp-page";
import { kitchenConfigGuard } from "@/features/ws04-kitchen-config/guard";

// /kelola/dapur/remake — every remake and comp with reason, staff and
// ingredient cost (PRD §3 F12 "Remake & Comp", KDS-07).
export const Route = createFileRoute("/_kelola/kelola/dapur_/remake")({
  beforeLoad: kitchenConfigGuard([
    "kds.remake_comp.record",
    "kds.station.manage",
  ]),
  component: RemakeScreen,
});

function RemakeScreen() {
  return (
    <KitchenConfigPage active="remake">
      <RemakeCompPage />
    </KitchenConfigPage>
  );
}
