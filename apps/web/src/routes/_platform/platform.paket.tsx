import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PaketPage } from "@/features/ws01-platform-ops/components/paket-page";
import {
  opsGuard,
  PAKET_PERMISSIONS,
} from "@/features/ws01-platform-ops/guard";
import { holdsAny } from "@/lib/areas/guard";

const t = createTranslator();

// /platform/paket — packages and module feature flags (bead legend-y6s;
// PRD §3 F4 "Feature Flag & Paket", TEN-05).
export const Route = createFileRoute("/_platform/platform/paket")({
  beforeLoad: opsGuard(PAKET_PERMISSIONS),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("platformOps.paket.pageTitle"),
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
    <PaketPage canManage={holdsAny(access, ["platform.package.manage"])} />
  );
}
