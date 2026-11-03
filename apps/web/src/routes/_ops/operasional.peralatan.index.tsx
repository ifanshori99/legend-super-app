import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { EquipmentRegistryScreen } from "@/features/operations-equipment/components/equipment-registry-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/peralatan — equipment registry, service schedules and breakdown
// tickets (PRD v1.7 §3 F41 "Peralatan & Perawatan"; OPS-04). The area layout
// already gates the ops shell; this page needs the domain permission too.
export const Route = createFileRoute("/_ops/operasional/peralatan/")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["ops.equipment.maintain"],
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
            page: t("opsEquipment.equipment.pageTitle"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: EquipmentRegistryPage,
});

function EquipmentRegistryPage() {
  return <EquipmentRegistryScreen />;
}
