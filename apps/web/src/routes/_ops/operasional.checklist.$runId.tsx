import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ChecklistRunPage } from "@/features/operations-checklist/components/run-execution-page";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/checklist/$runId — phone-first checklist execution (bead
// legend-td4f; PRD v1.7 §3 F41, OPS-01). Presentation-only guard; the API
// re-checks every write.
export const Route = createFileRoute("/_ops/operasional/checklist/$runId")({
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
            page: t("opsChecklist.run.progressTitle"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: ChecklistRunRoute,
});

function ChecklistRunRoute() {
  const { runId } = Route.useParams();
  return <ChecklistRunPage runId={runId} />;
}
