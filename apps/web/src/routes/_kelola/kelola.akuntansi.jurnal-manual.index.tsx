import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import { ManualJournalListPage } from "@/features/ws07-accounting/components/manual-journal-list-page";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi/jurnal-manual — manual journals and their approval status
// (PRD §3.19 Jurnal Manual & Berulang).
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/jurnal-manual/",
)({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: ManualJournalListRoute,
});

function ManualJournalListRoute() {
  return (
    <AccountingPage active="manual">
      <EntityScope>
        {(entity) => <ManualJournalListPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
