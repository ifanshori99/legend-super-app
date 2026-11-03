import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";
import { CashBankPage } from "@/features/ws07-cash-bank/components/cash-bank-page";

// /kelola/akuntansi/kas-bank — cash & bank (PRD §3.19, ACC-04, ACC-05).
export const Route = createFileRoute("/_kelola/kelola/akuntansi/kas-bank")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: CashBankRoute,
});

function CashBankRoute() {
  return (
    <AccountingPage active="cash">
      <EntityScope>
        {(entity) => <CashBankPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
