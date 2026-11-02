import { createFileRoute } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { TaxPage } from "@/features/ws05-tax/components/tax-page";
import { TaxSettingsPage } from "@/features/ws05-tax/components/tax-settings-page";
import { taxConfigGuard, taxSectionAccess } from "@/features/ws05-tax/guard";
import { taxSettingsDefaultQuery } from "@/features/ws05-tax/queries";
import { API_MOCK } from "@/lib/api/mock-flag";

// /kelola/pajak/opsi — calculation options (PRD v1.7 §3.14 "Opsi
// Perhitungan"): exclusive prices by default, rounding, cash rounding and
// package allocation, versioned with effective dates.
export const Route = createFileRoute("/_kelola/kelola/pajak/opsi")({
  beforeLoad: taxConfigGuard,
  loader: ({ context }) =>
    API_MOCK
      ? undefined
      : context.queryClient.ensureQueryData(taxSettingsDefaultQuery()),
  component: TaxSettingsRoute,
});

function TaxSettingsRoute() {
  const t = useT();
  const { access } = Route.useRouteContext();
  const { canReport } = taxSectionAccess(access);
  return (
    <TaxPage
      active="settings"
      title={t("tax.title")}
      description={t("tax.subtitle")}
      canConfigure
      canReport={canReport}
    >
      <TaxSettingsPage />
    </TaxPage>
  );
}
