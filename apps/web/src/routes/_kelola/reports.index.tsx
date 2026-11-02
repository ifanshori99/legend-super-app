import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ReportCatalogPage } from "@/features/ws11-reports/components/catalog-page";

const t = createTranslator();

// /reports — report catalog (PRD v1.7 §3 F36 "Laporan"). The kelola layout
// already guards dashboard.management.view + MFA; each report re-checks its own
// permission.
export const Route = createFileRoute("/_kelola/reports/")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("reportViewer.title"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  component: ReportCatalogPage,
});
