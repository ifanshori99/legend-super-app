import { createFileRoute } from "@tanstack/react-router";
import { InvoiceListPage } from "@/features/ws06-purchasing/components/invoice-page";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import { supplierInvoicesQuery } from "@/features/ws06-purchasing/receiving-queries";
import {
  purchaseOrdersQuery,
  suppliersQuery,
} from "@/features/ws06-purchasing/queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/pengadaan/faktur — supplier invoices with the three-way match and
// payment request (PRD v1.7 §3.18, §4 Alur I step 4, §3.7 approval).
export const Route = createFileRoute("/_kelola/kelola/pengadaan_/faktur")({
  beforeLoad: purchasingGuard(["purchasing.invoice.match"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            supplierInvoicesQuery({
              outletId: INVENTORY_OUTLET_ID,
              limit: 100,
            }),
          ),
          context.queryClient.ensureQueryData(
            purchaseOrdersQuery(INVENTORY_OUTLET_ID),
          ),
          context.queryClient.ensureQueryData(suppliersQuery()),
        ]),
  component: InvoiceListScreen,
});

function InvoiceListScreen() {
  const { access } = Route.useRouteContext();
  return (
    <PurchasingFrame active="invoices">
      <InvoiceListPage
        canPay={holdsAny(access, ["accounting.supplier_payment.process"])}
      />
    </PurchasingFrame>
  );
}
