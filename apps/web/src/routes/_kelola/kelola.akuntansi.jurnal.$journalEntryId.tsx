import { createFileRoute } from "@tanstack/react-router";
import { JournalDetailPage } from "@/features/ws07-accounting/components/journal-detail-page";
import {
  ACCOUNTING_VIEW,
  accountingGuard,
} from "@/features/ws07-accounting/guard";

// /kelola/akuntansi/jurnal/$journalEntryId — lines, balance and the source
// document (ACC-01, ACC-03).
export const Route = createFileRoute(
  "/_kelola/kelola/akuntansi/jurnal/$journalEntryId",
)({
  beforeLoad: accountingGuard(ACCOUNTING_VIEW),
  component: JournalDetailRoute,
});

function JournalDetailRoute() {
  const { journalEntryId } = Route.useParams();
  return <JournalDetailPage journalEntryId={journalEntryId} />;
}
