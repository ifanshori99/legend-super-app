import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountingPage } from "@/features/ws07-accounting/components/accounting-shell";
import { ManualJournalFormPage } from "@/features/ws07-accounting/components/manual-journal-form-page";
import {
  ACCOUNTING_POST,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import {
  useLegalEntities,
  useManualJournal,
} from "@/features/ws07-accounting/hooks";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";

// /kelola/akuntansi/jurnal-manual/$manualJournalId/ubah — only a draft or a
// rejected journal can be edited; the contract refuses the rest.
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/jurnal-manual/$manualJournalId/ubah",
)({
  beforeLoad: accountingGuard(ACCOUNTING_POST),
  component: EditManualJournalRoute,
});

function EditManualJournalRoute() {
  const t = useT();
  const { manualJournalId } = Route.useParams();
  const journalQuery = useManualJournal(manualJournalId);
  const entitiesQuery = useLegalEntities();

  if (journalQuery.isPending)
    return (
      <AccountingPage active="manual">
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </AccountingPage>
    );

  if (journalQuery.isError)
    return (
      <AccountingPage active="manual">
        <ErrorState
          onRetry={() => {
            void journalQuery.refetch();
          }}
        />
      </AccountingPage>
    );

  const journal = journalQuery.data;
  if (journal.status !== "draft" && journal.status !== "rejected")
    return (
      <AccountingPage active="manual">
        <EmptyState
          title={t("accounting.manual.form.titleEdit")}
          description={t("accounting.manual.subtitle")}
          action={
            <Button asChild variant="outline" size="sm">
              <Link
                to="/kelola/akuntansi/jurnal-manual/$manualJournalId"
                params={{ manualJournalId: journal.id }}
              >
                {t("accounting.manual.detail.back")}
              </Link>
            </Button>
          }
        />
      </AccountingPage>
    );

  const entityName = entitiesQuery.data?.find(
    (entity) => entity.id === journal.legalEntityId,
  )?.name;

  return (
    <AccountingPage active="manual">
      <ManualJournalFormPage
        legalEntityId={journal.legalEntityId}
        entityName={entityName}
        journal={journal}
      />
    </AccountingPage>
  );
}
