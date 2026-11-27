import { createFileRoute } from "@tanstack/react-router";
import { EdcSettlementImportPage } from "@/features/edc-settlement-import/components/import-page";
import { edcReconciliationGuard } from "@/features/edc-reconciliation/guard";

// /kelola/pembayaran/edc-settlement: upload of a bank's EDC settlement CSV
// (legend-wasr7.18). Same permission as the API route (payment.reconcile). The
// trailing underscore in the file name keeps this page out of the payment back
// office layout, like the EDC reconciliation page.
export const Route = createFileRoute(
  "/_kelola/kelola/pembayaran_/edc-settlement",
)({
  beforeLoad: edcReconciliationGuard,
  component: EdcSettlementImportPage,
});
