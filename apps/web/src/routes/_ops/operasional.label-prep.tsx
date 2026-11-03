import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PrepLabelsScreen } from "@/features/operations-food-safety/components/label-prep-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/label-prep — prep labels with use-by, batch and printing (bead
// legend-d983; PRD v1.7 §3 F41 "Label Prep", OPS-03). Presentation-only guard;
// the API re-checks the permission and the batch/use-by rules.
export const Route = createFileRoute("/_ops/operasional/label-prep")({
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
            page: t("opsFoodSafety.prepLabels.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: LabelPrepPage,
});

function LabelPrepPage() {
  const { session } = Route.useRouteContext();
  return <PrepLabelsScreen responsibleName={session?.user.name ?? ""} />;
}
