import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { evaluateGuard } from "@/lib/areas/guard";
import { ReportBuilderPage } from "@/features/ws11-report-builder/components/builder-page";

const t = createTranslator();

// /reports/builder — report builder on the metric layer (PRD v1.7 §3 F36).
// The kelola area already requires dashboard.management.view + MFA; the page
// additionally needs one of the report permissions, and the builder only
// offers the metrics whose source report the caller's permissions open
// (docs/frontend.md "Page guard"). The API re-checks every call.
export const Route = createFileRoute("/_kelola/reports/builder")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: [
          "report.aggregate.view",
          "report.operational.view",
          "report.sales.view",
          "report.financial.view",
        ],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("reportBuilder.title"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  component: BuilderScreen,
});

function BuilderScreen() {
  const { access } = Route.useRouteContext();
  return <ReportBuilderPage permissions={access.permissions} />;
}
