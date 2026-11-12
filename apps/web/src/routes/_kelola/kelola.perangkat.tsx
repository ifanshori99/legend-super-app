import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { DeviceRegistryPage } from "@/features/ws02-devices/components/registry-page";
import { accessGuard } from "@/features/ws01-access/guard";
import { holdsAny } from "@/lib/areas/guard";

const t = createTranslator();

// /kelola/perangkat — device registry per outlet (bead legend-q2c; PRD v1.7
// §3 F5 Registri Perangkat, Mode Latihan; EDG-03 UI). Presentation-only guard;
// the API re-checks every request.
export const Route = createFileRoute("/_kelola/kelola/perangkat")({
  beforeLoad: accessGuard(["device.registry.manage", "device.registry.revoke"]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("deviceRegistry.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DevicesScreen,
});

function DevicesScreen() {
  const { access } = Route.useRouteContext();
  return (
    <DeviceRegistryPage
      outlets={access.outlets}
      canManage={holdsAny(access, ["device.registry.manage"])}
      canRevoke={holdsAny(access, ["device.registry.revoke"])}
    />
  );
}
