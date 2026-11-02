import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { ChartOfAccountsPage } from "@/features/ws07-accounting/components/coa-page";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi — chart of accounts per legal entity (PRD §3.19).
export const Route = createFileRoute("/_kelola/kelola/akuntansi/")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: ChartOfAccountsRoute,
});

function ChartOfAccountsRoute() {
  return (
    <AccountingPage active="coa">
      <EntityScope>
        {(entity) => <ChartOfAccountsPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
