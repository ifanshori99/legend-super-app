import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { EquipmentDetailScreen } from "@/features/operations-equipment/components/equipment-detail-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/peralatan/$equipmentId — one equipment's status, service and
// cost history, and the typed transitions (PRD v1.7 §3 F41 "Peralatan &
// Perawatan"; OPS-04).
export const Route = createFileRoute(
  "/_ops/operasional/peralatan/$equipmentId",
)({
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
  component: EquipmentDetailPage,
});

function EquipmentDetailPage() {
  const { equipmentId } = Route.useParams();
  return <EquipmentDetailScreen equipmentId={equipmentId} />;
}
