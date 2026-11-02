import { createFileRoute } from "@tanstack/react-router";
import { KitchenConfigPage } from "@/features/ws04-kitchen-config/components/kitchen-config-page";
import { ServingTimePage } from "@/features/ws04-kitchen-config/components/serving-time-page";
import { kitchenConfigGuard } from "@/features/ws04-kitchen-config/guard";

// /kelola/dapur/laporan — serving-time analytics by station, hour, employee or
// item (PRD §3 F12 "Analitik Serving Time").
export const Route = createFileRoute("/_kelola/kelola/dapur_/laporan")({
  beforeLoad: kitchenConfigGuard([
    "report.operational.view",
    "kds.station.manage",
  ]),
  component: ServingScreen,
});

function ServingScreen() {
  return (
    <KitchenConfigPage active="serving">
      <ServingTimePage />
    </KitchenConfigPage>
  );
}
