import { createFileRoute } from "@tanstack/react-router";
import { FixedAssetsPage } from "@/features/ws07-ap-assets/components/assets-page";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi/aset-tetap — fixed assets (PRD §3.19 "Aset Tetap").
export const Route = createFileRoute("/_kelola/kelola/akuntansi/aset-tetap")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: FixedAssetsRoute,
});

function FixedAssetsRoute() {
  return (
    <AccountingPage active="assets">
      <EntityScope>
        {(entity) => <FixedAssetsPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
