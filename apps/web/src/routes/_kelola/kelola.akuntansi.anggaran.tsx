import { createFileRoute } from "@tanstack/react-router";
import { BudgetsPage } from "@/features/ws07-ap-assets/components/budgets-page";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi/anggaran — budgets vs actual (PRD §3.19 "Anggaran").
export const Route = createFileRoute("/_kelola/kelola/akuntansi/anggaran")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: BudgetsRoute,
});

function BudgetsRoute() {
  return (
    <AccountingPage active="budgets">
      <EntityScope>
        {(entity) => <BudgetsPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
