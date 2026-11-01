import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { KoneksiScreen } from "@/features/ws02-edge/components/koneksi-screen";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";

// /operasional/koneksi — supervisor monitor for cloud link, sync backlog,
// print queue and printer/KDS alerts (bead legend-diq; PRD v1.7 §3 F5,
// §4 Alur F, EDG-05). Presentation-only guard; the API re-checks.
export const Route = createFileRoute("/_ops/operasional/koneksi")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["report.operational.view"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => {
    const t = createTranslator();
    return {
      meta: [
        {
          title: t("app.titleTemplate", {
            page: t("edge.pageTitle"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: KoneksiPage,
});

function KoneksiPage() {
  const { access } = Route.useRouteContext();
  return (
    <KoneksiScreen
      canManageDevices={holdsAny(access, ["device.registry.manage"])}
    />
  );
}
