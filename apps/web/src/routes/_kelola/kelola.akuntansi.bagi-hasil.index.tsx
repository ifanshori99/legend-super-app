import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";
import { ProfitSharePage } from "@/features/ws07-profit-share/components/shareholders-page";

// /kelola/akuntansi/bagi-hasil — profit entities, versioned shares (SH-03) and
// the distribution policy (PRD §3.37, §4 "Alur P").
export const Route = createFileRoute("/_kelola/kelola/akuntansi/bagi-hasil/")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: ProfitShareRoute,
});

function ProfitShareRoute() {
  return (
    <AccountingPage active="shareholders">
      <EntityScope>
        {(entity) => <ProfitSharePage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
