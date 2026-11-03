import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";
import { StatementsPage } from "@/features/ws07-statements/components/statements-page";

// /kelola/akuntansi/laporan — financial statements with drill-down (PRD §3.19
// "Laporan Keuangan"; ACC-03).
export const Route = createFileRoute("/_kelola/kelola/akuntansi/laporan")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: StatementsRoute,
});

function StatementsRoute() {
  return (
    <AccountingPage active="statements">
      <EntityScope>
        {(entity) => <StatementsPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
