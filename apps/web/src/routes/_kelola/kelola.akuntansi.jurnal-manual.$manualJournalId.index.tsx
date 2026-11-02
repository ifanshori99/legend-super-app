import { createFileRoute } from "@tanstack/react-router";
import { ManualJournalDetailPage } from "@/features/ws07-accounting/components/manual-journal-detail-page";
import {
  ACCOUNTING_POST,
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/akuntansi/jurnal-manual/$manualJournalId — lines + approval actions.
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/jurnal-manual/$manualJournalId/",
)({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  component: ManualJournalDetailRoute,
});

function ManualJournalDetailRoute() {
  const { manualJournalId } = Route.useParams();
  const { access } = Route.useRouteContext();
  // AUTH-06: only a posting permission may approve/reject; the API also
  // refuses an approval by the requester.
  return (
    <ManualJournalDetailPage
      manualJournalId={manualJournalId}
      canPost={holdsAny(access, ACCOUNTING_POST)}
    />
  );
}
