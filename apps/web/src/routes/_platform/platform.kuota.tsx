import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { KuotaPage } from "@/features/ws01-platform-ops/components/kuota-page";
import {
  opsGuard,
  PAKET_PERMISSIONS,
} from "@/features/ws01-platform-ops/guard";
import { holdsAny } from "@/lib/areas/guard";

const t = createTranslator();

// /platform/kuota — quotas, cost caps and available gateways (bead
// legend-y6s; PRD §3 F4 "Kuota & Plafon").
export const Route = createFileRoute("/_platform/platform/kuota")({
  beforeLoad: opsGuard(PAKET_PERMISSIONS),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("platformOps.quota.pageTitle"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Screen,
});

function Screen() {
  const { access } = Route.useRouteContext();
  return (
    <KuotaPage
      canManage={holdsAny(access, ["platform.package.manage"])}
      canManageGateways={holdsAny(access, [
        "platform.package.manage",
        "platform.integration.manage",
      ])}
    />
  );
}
