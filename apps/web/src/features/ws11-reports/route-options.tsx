// The options every report route shares, so a family bead adds one thin route
// file per report code (`createFileRoute("/_kelola/reports/<family>/<code>")(
// reportRouteOptions("<family>.<code>"))`) and nothing else. The path itself
// must equal reportRouteForCode(code) from @starter/shared/dashboard, because
// dashboard tiles link to it (DASH-01) and hide the link until the route
// exists (use-route-available).
import { reportByCode } from "@starter/shared/dashboard";
import { createTranslator } from "@starter/shared/i18n";
import { ReportViewerPage } from "./components/report-viewer-page";
import { reportGuard } from "./guard";
import { validateReportSearch } from "./lib";

const t = createTranslator();

export function reportRouteOptions(reportCode: string) {
  return {
    beforeLoad: reportGuard(reportCode),
    validateSearch: validateReportSearch,
    head: () => ({
      meta: [
        {
          title: t("app.titleTemplate", {
            page: reportByCode(reportCode)?.name ?? t("reportViewer.title"),
            brand: t("app.defaultBrand"),
          }),
        },
      ],
    }),
    component: function ReportRoute() {
      return <ReportViewerPage reportCode={reportCode} />;
    },
  };
}
