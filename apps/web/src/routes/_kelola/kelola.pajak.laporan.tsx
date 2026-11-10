import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useT } from "@/components/i18n";
import { PbjtReportPage } from "@/features/ws05-tax/components/pbjt-report-page";
import { TaxPage } from "@/features/ws05-tax/components/tax-page";
import { taxReportGuard, taxSectionAccess } from "@/features/ws05-tax/guard";
import { currentTaxPeriod, isTaxPeriod } from "@/features/ws05-tax/lib";

// /kelola/pajak/laporan — monthly PBJT recap per outlet for the regional
// filing (PRD v1.7 §3.14 "Laporan Pajak"). Finance-only: the page guard asks
// accounting.tax_report.manage.
const searchSchema = z.object({
  period: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_kelola/kelola/pajak/laporan")({
  beforeLoad: taxReportGuard,
  validateSearch: searchSchema,
  // The period lives in the URL so one month's recap can be shared.
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
  component: PbjtReportRoute,
});

function PbjtReportRoute() {
  const t = useT();
  const { access } = Route.useRouteContext();
  const { canConfigure } = taxSectionAccess(access);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const period = isTaxPeriod(search.period)
    ? search.period
    : currentTaxPeriod();
  return (
    <TaxPage
      active="report"
      title={t("tax.report.title")}
      description={t("tax.report.subtitle")}
      canConfigure={canConfigure}
      canReport
    >
      <PbjtReportPage
        period={period}
        onPeriodChange={(next) =>
          void navigate({
            search: (previous) => ({ ...previous, period: next }),
            replace: true,
          })
        }
      />
    </TaxPage>
  );
}
