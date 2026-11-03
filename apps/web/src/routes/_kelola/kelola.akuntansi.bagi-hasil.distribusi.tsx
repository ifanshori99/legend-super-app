import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";
import { DistributionsPage } from "@/features/ws07-profit-share/components/distributions-page";

// /kelola/akuntansi/bagi-hasil/distribusi — the distribution cycle (PRD §3.37
// "Siklus Distribusi", §4 "Alur P", SH-04).
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/bagi-hasil/distribusi",
)({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: DistributionsRoute,
});

function DistributionsRoute() {
  return (
    <AccountingPage active="distributions">
      <EntityScope>
        {(entity) => <DistributionsPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
