import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PrepListScreen } from "@/features/operations-food-safety/components/prep-list-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/prep — daily prep list and its status transition (bead
// legend-d983; PRD v1.7 §3 F41 "Daftar Prep Harian"). Presentation-only guard;
// the API re-checks the permission and the state machine.
export const Route = createFileRoute("/_ops/operasional/prep")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["ops.prep.manage"],
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
            page: t("opsFoodSafety.prepList.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: PrepListPage,
});

function PrepListPage() {
  return <PrepListScreen />;
}
