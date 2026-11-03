import { createFileRoute } from "@tanstack/react-router";
import { accessGuard } from "@/features/ws01-access/guard";
import { ConfigPage } from "@/features/ws01-tenant-settings/components/config-page";

// /kelola/pengaturan/konfigurasi — config bundle export and import with a
// preview diff (PRD §3 F4 "Konfigurasi sebagai Data & Template Tenant", TEN-09).
export const Route = createFileRoute("/_kelola/kelola/pengaturan_/konfigurasi")(
  {
    beforeLoad: accessGuard(["org.config.export"]),
    component: ConfigScreen,
  },
);

function ConfigScreen() {
  const { access } = Route.useRouteContext();
  return <ConfigPage access={access} />;
}
