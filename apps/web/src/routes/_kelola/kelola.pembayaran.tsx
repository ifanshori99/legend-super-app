import { createFileRoute } from "@tanstack/react-router";
import { PaymentAdminPage } from "@/features/ws05-payment-admin/components/payment-admin-page";
import { paymentAdminGuard } from "@/features/ws05-payment-admin/guard";
import {
  PAYMENT_ADMIN_PERMISSIONS,
  isMockScenarioRequest,
} from "@/features/ws05-payment-admin/lib";
import { routingQuery } from "@/features/ws05-payment-admin/queries";
import { API_MOCK } from "@/lib/api/mock-flag";

// /kelola/pembayaran — payment back office (PRD §3 F13): routing, EDC,
// refunds, unallocated funds, settlement reconciliation. The layout runs the
// area guard; this page needs one of the payment permissions.
export const Route = createFileRoute("/_kelola/kelola/pembayaran")({
  beforeLoad: paymentAdminGuard(PAYMENT_ADMIN_PERMISSIONS),
  // Mock mode serves the clickable demo: let the browser fetch so ?mock=empty
  // and ?mock=error apply instead of hydrating the server's fixture render.
  loader: ({ context, location }) =>
    API_MOCK || isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(routingQuery({})),
  component: PaymentAdminPage,
});
