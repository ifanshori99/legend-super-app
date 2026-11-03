import { createFileRoute } from "@tanstack/react-router";
import { CrmPage } from "@/features/ws08-crm-360/components/crm-shell";
import { CustomerDetailPage } from "@/features/ws08-crm-360/components/customer-detail-page";
import { crm360Guard } from "@/features/ws08-crm-360/guard";

// /kelola/pelanggan/$customerProfileId — one Customer 360 profile (PRD v1.7
// §3.21 "Customer 360"). No loader: the profile, consents and point ledger are
// PII-bearing reads, so they stay in the browser under the visitor's session
// and are never serialised into the SSR document.
//
// The page guard requires crm.customer.view, the same permission the API
// applies; the screen also masks the two remaining PII fields if that guard is
// ever loosened.
export const Route = createFileRoute(
  "/_kelola/kelola/pelanggan/$customerProfileId",
)({
  beforeLoad: crm360Guard(["crm.customer.view"]),
  component: CustomerDetailScreen,
});

function CustomerDetailScreen() {
  const { customerProfileId } = Route.useParams();
  return (
    <CrmPage active="customers">
      <CustomerDetailPage customerProfileId={customerProfileId} />
    </CrmPage>
  );
}
