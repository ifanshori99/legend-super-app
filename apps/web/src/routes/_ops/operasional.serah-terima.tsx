import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { HandoverScreen } from "@/features/operations-equipment/components/handover-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/serah-terima — structured shift handover and the receiving
// shift's confirmation (PRD v1.7 §3 F41 "Serah Terima Shift"; OPS-05).
export const Route = createFileRoute("/_ops/operasional/serah-terima")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["ops.handover.record"],
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
            page: t("opsEquipment.handover.pageTitle"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: HandoverPage,
});

function HandoverPage() {
  return <HandoverScreen />;
}
