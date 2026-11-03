import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";
import { ReconciliationPage } from "@/features/ws07-cash-bank/components/recon-page";

// /kelola/akuntansi/rekonsiliasi — gateway reconciliation (PRD §3.19, ACC-04).
export const Route = createFileRoute("/_kelola/kelola/akuntansi/rekonsiliasi")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: ReconciliationRoute,
});

function ReconciliationRoute() {
  return (
    <AccountingPage active="recon">
      <EntityScope>
        {(entity) => <ReconciliationPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
