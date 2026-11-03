import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";
import { PeriodsPage } from "@/features/ws07-statements/components/periods-page";

// /kelola/akuntansi/tutup-periode — close with snapshot, reopen with approval
// (PRD §3.19 "Tutup Periode"; ACC-02).
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/tutup-periode",
)({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: PeriodsRoute,
});

function PeriodsRoute() {
  return (
    <AccountingPage active="periods">
      <EntityScope>
        {(entity) => <PeriodsPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
