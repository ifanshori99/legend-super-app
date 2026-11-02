import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import { RecurringJournalsPage } from "@/features/ws07-accounting/components/recurring-journals-page";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi/jurnal-berulang — recurring templates (PRD §3.19).
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/jurnal-berulang",
)({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: RecurringJournalsRoute,
});

function RecurringJournalsRoute() {
  return (
    <AccountingPage active="recurring">
      <EntityScope>
        {(entity) => <RecurringJournalsPage legalEntityId={entity.id} />}
      </EntityScope>
    </AccountingPage>
  );
}
