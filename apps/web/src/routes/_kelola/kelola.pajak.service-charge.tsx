import { createFileRoute } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { ServiceChargePage } from "@/features/ws05-tax/components/service-charge-page";
import { TaxPage } from "@/features/ws05-tax/components/tax-page";
import { taxConfigGuard, taxSectionAccess } from "@/features/ws05-tax/guard";
import { serviceChargeRulesDefaultQuery } from "@/features/ws05-tax/queries";
import { API_MOCK } from "@/lib/api/mock-flag";

// /kelola/pajak/service-charge — service-charge rules per zone/order type
// (PRD v1.7 §3.14 "Service Charge").
export const Route = createFileRoute("/_kelola/kelola/pajak/service-charge")({
  beforeLoad: taxConfigGuard,
  loader: ({ context }) =>
    API_MOCK
      ? undefined
      : context.queryClient.ensureQueryData(serviceChargeRulesDefaultQuery()),
  component: ServiceChargeRoute,
});

function ServiceChargeRoute() {
  const t = useT();
  const { access } = Route.useRouteContext();
  const { canReport } = taxSectionAccess(access);
  return (
    <TaxPage
      active="service-charge"
      title={t("tax.title")}
      description={t("tax.subtitle")}
      canConfigure
      canReport={canReport}
    >
      <ServiceChargePage />
    </TaxPage>
  );
}
