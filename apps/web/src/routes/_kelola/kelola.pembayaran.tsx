import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PaymentAdminPage } from "@/features/ws05-payment-admin/components/payment-admin-page";
import { paymentAdminGuard } from "@/features/ws05-payment-admin/guard";
import {
  PAYMENT_ADMIN_PERMISSIONS,
  ROUTING_MANAGE_PERMISSION,
  isMockScenarioRequest,
  type PaymentAdminTab,
} from "@/features/ws05-payment-admin/lib";
import { routingQuery } from "@/features/ws05-payment-admin/queries";
import { API_MOCK } from "@/lib/api/mock-flag";

// /kelola/pembayaran — payment back office (PRD §3 F13): routing, EDC,
// refunds, unallocated funds, settlement reconciliation. The layout runs the
// area guard; this page needs one of the payment permissions. The open tab
// lives in the URL (?tab=); an unknown value is dropped, and a tab the account
// may not see falls back to its first visible tab inside the page.
const PAYMENT_ADMIN_TAB_IDS = [
  "routing",
  "duitku",
  "edc",
  "refunds",
  "unallocated",
  "reconciliation",
] as const satisfies readonly PaymentAdminTab[];

export const Route = createFileRoute("/_kelola/kelola/pembayaran")({
  validateSearch: z.object({
    tab: z.enum(PAYMENT_ADMIN_TAB_IDS).optional().catch(undefined),
  }),
  beforeLoad: paymentAdminGuard(PAYMENT_ADMIN_PERMISSIONS),
  // Mock mode serves the clickable demo: let the browser fetch so ?mock=empty
  // and ?mock=error apply instead of hydrating the server's fixture render.
  // Routing GET needs org.settings.manage (sub-302 D14): without it the loader
  // must not fetch (it would 403 and break the other tabs).
  loader: ({ context, location }) =>
    API_MOCK ||
    isMockScenarioRequest(location.searchStr) ||
    !context.access.permissions.includes(ROUTING_MANAGE_PERMISSION)
      ? undefined
      : context.queryClient.ensureQueryData(routingQuery({})),
  component: PaymentScreen,
});

function PaymentScreen() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PaymentAdminPage
      tab={search.tab}
      onTabChange={(tab) => {
        void navigate({
          search: (prev) => ({ ...prev, tab }),
          replace: true,
        });
      }}
    />
  );
}
