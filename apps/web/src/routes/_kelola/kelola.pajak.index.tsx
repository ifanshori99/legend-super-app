import { createFileRoute } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { TaxPage } from "@/features/ws05-tax/components/tax-page";
import { TaxRulesPage } from "@/features/ws05-tax/components/tax-rules-page";
import { taxConfigGuard, taxSectionAccess } from "@/features/ws05-tax/guard";
import { taxRulesDefaultQuery } from "@/features/ws05-tax/queries";
import { API_MOCK } from "@/lib/api/mock-flag";

// /kelola/pajak — tax rule versions (PRD v1.7 §3.14 "Aturan Pajak Berversi").
// The area layout runs the management guard; this page needs the tax-config
// permission (tenant admin). Mock mode skips the loader so ?mock=empty and
// ?mock=error reach the browser fetch.
export const Route = createFileRoute("/_kelola/kelola/pajak/")({
  beforeLoad: taxConfigGuard,
  loader: ({ context }) =>
    API_MOCK
      ? undefined
      : context.queryClient.ensureQueryData(taxRulesDefaultQuery()),
  component: TaxRulesRoute,
});

function TaxRulesRoute() {
  const t = useT();
  const { access } = Route.useRouteContext();
  const { canReport } = taxSectionAccess(access);
  return (
    <TaxPage
      active="rules"
      description={t("tax.subtitle")}
      canConfigure
      canReport={canReport}
    >
      <TaxRulesPage />
    </TaxPage>
  );
}
