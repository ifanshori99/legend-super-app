import { createFileRoute } from "@tanstack/react-router";
import { CrmPage } from "@/features/ws08-crm-360/components/crm-shell";
import { CustomersPage } from "@/features/ws08-crm-360/components/customers-page";
import { crm360Guard } from "@/features/ws08-crm-360/guard";

// /kelola/pelanggan — Customer 360 directory (PRD v1.7 §3.21 "Customer 360").
// No loader: the list carries customer PII (birth day, referral code), so it
// is fetched by the browser with the visitor's own session and never frozen
// into the SSR HTML or the dehydrated cache (same rule as the employee
// profile). `?mock=empty|error|offline` therefore reaches the browser fetch.
export const Route = createFileRoute("/_kelola/kelola/pelanggan/")({
  beforeLoad: crm360Guard(["crm.customer.view"]),
  component: CustomersScreen,
});

function CustomersScreen() {
  return (
    <CrmPage active="customers">
      <CustomersPage />
    </CrmPage>
  );
}
