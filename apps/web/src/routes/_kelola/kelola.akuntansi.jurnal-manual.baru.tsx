import { createFileRoute } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { EntityScope } from "@/features/ws07-accounting/components/entity-picker";
import { ManualJournalFormPage } from "@/features/ws07-accounting/components/manual-journal-form-page";
import {
  ACCOUNTING_POST,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { isMockScenarioRequest } from "@/features/ws07-accounting/lib";
import { legalEntitiesQuery } from "@/features/ws07-accounting/queries";

// /kelola/akuntansi/jurnal-manual/baru — draft a manual journal (requested by
// finance, posted only after a different person approves it).
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/jurnal-manual/baru",
)({
  beforeLoad: accountingGuard(ACCOUNTING_POST),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: NewManualJournalRoute,
});

function NewManualJournalRoute() {
  return (
    <AccountingPage active="manual">
      <EntityScope>
        {(entity) => (
          <ManualJournalFormPage
            legalEntityId={entity.id}
            entityName={entity.name}
          />
        )}
      </EntityScope>
    </AccountingPage>
  );
}
