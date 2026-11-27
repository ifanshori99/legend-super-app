import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { edcReconciliationGuard } from "@/features/edc-reconciliation/guard";
import { GatewaySettlementImportPage } from "@/features/ws05-payment-admin/components/settlement-import-page";

// /kelola/pembayaran/settlement-duitku: Duitku settlement import (C4b,
// legend-osqou.8). Same permission as the API route (payment.reconcile). The
// trailing underscore keeps this page out of the payment back office layout,
// like the EDC settlement upload. `?outletId=` preselects the outlet the
// reconciliation panel was showing; a malformed value falls back to "not set".
export const Route = createFileRoute(
  "/_kelola/kelola/pembayaran_/settlement-duitku",
)({
  validateSearch: z.object({
    outletId: z.string().trim().min(1).max(64).optional().catch(undefined),
  }),
  beforeLoad: edcReconciliationGuard,
  component: GatewaySettlementImportPage,
});
