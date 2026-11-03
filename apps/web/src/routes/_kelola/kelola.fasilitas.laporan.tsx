import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { FacilityReportHub } from "@/features/facility-report/components/facility-report-hub";
import { evaluateGuard } from "@/lib/areas/guard";

const t = createTranslator();

// /kelola/fasilitas/laporan — facility & WFC report hub (PRD v1.7 §3 F25
// "Laporan" and "Pengukuran WFC"). The kelola layout already guards
// dashboard.management.view + MFA; this page additionally needs
// `report.operational.view` (docs/frontend.md "Page guard"). No loader: the six
// definitions come from the static catalog, so nothing is fetched and the
// ?mock= scenarios have nothing to freeze into the SSR HTML.
export const Route = createFileRoute("/_kelola/kelola/fasilitas/laporan")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "dashboard",
        anyOf: ["report.operational.view"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("facilityReport.hub.title"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  component: FacilityReportHub,
});
