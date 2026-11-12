import { createFileRoute } from "@tanstack/react-router";
import { AccountMappingsPage } from "@/features/ws07-accounting/components/account-mappings-page";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi/pemetaan — account-role mapping per legal entity
// (legend-fzvh): which account each automatic-journal role posts to.
export const Route = createFileRoute("/_kelola/kelola/akuntansi/pemetaan")({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: AccountMappingsRoute,
});

function AccountMappingsRoute() {
  return (
    <AccountingPage active="mapping">
      <AccountMappingsPage />
    </AccountingPage>
  );
}
