import { createFileRoute } from "@tanstack/react-router";
import { edcReconciliationGuard } from "@/features/edc-reconciliation/guard";
import { GatewaySettlementImportPage } from "@/features/ws05-payment-admin/components/settlement-import-page";

// /kelola/pembayaran/settlement-duitku: Duitku settlement import (C4b,
// legend-osqou.8). Same permission as the API route (payment.reconcile). The
// trailing underscore keeps this page out of the payment back office layout,
// like the EDC settlement upload.
export const Route = createFileRoute(
  "/_kelola/kelola/pembayaran_/settlement-duitku",
)({
  beforeLoad: edcReconciliationGuard,
  component: GatewaySettlementImportPage,
});
