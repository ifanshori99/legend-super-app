import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";
import { TaxPage } from "@/features/ws07-tax/components/tax-page";

// /kelola/akuntansi/pajak — tax recap & Coretax export (PRD §3 F19).
export const Route = createFileRoute("/_kelola/kelola/akuntansi/pajak")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: TaxRecapRoute,
});

function TaxRecapRoute() {
  return (
    <AccountingPage active="tax">
      <EntityScope>{(entity) => <TaxPage legalEntity={entity} />}</EntityScope>
    </AccountingPage>
  );
}
