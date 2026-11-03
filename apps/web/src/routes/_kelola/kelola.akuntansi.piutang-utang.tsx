import { createFileRoute } from "@tanstack/react-router";
import { AgingPage } from "@/features/ws07-ap-assets/components/aging-page";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi/piutang-utang — utang & piutang (PRD §3.19 "Utang & Piutang").
export const Route = createFileRoute("/_kelola/kelola/akuntansi/piutang-utang")(
  {
    beforeLoad: accountingGuard(ACCOUNTING_VIEW),
    loader: ({ context, location }) =>
      isMockScenarioRequest(location.searchStr)
        ? undefined
        : context.queryClient.ensureQueryData(legalEntitiesQuery()),
    component: AgingRoute,
  },
);

function AgingRoute() {
  return (
    <AccountingPage active="aging">
      <EntityScope>
        {(entity) => <AgingPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
