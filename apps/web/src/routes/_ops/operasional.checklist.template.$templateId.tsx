import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { TemplateBuilderPage } from "@/features/operations-checklist/components/template-builder-page";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/checklist/template/$templateId — the template builder; `baru`
// creates (bead legend-td4f; PRD v1.7 §3 F41). Presentation-only guard; the
// API re-checks every write.
export const Route = createFileRoute(
  "/_ops/operasional/checklist/template/$templateId",
)({
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
            page: t("opsChecklist.templates.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: TemplateBuilderRoute,
});

function TemplateBuilderRoute() {
  const { templateId } = Route.useParams();
  return <TemplateBuilderPage templateId={templateId} />;
}
