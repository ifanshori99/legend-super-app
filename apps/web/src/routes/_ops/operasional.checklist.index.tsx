import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ChecklistBoardPage } from "@/features/operations-checklist/components/checklist-board-page";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/checklist — the checklist board (bead legend-td4f; PRD v1.7 §3
// F41 "Checklist Operasional", OPS-01). Presentation-only guard; the API
// re-checks every request.
export const Route = createFileRoute("/_ops/operasional/checklist/")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["ops.checklist.complete"],
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
            page: t("opsChecklist.runs.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: ChecklistBoardPage,
});
