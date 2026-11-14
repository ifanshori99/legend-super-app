import { createFileRoute } from "@tanstack/react-router";
import { InvoiceFormPage } from "@/features/ws06-purchasing/components/invoice-form-page";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import {
  inventoryItemsQuery,
  suppliersQuery,
  uomsQuery,
} from "@/features/ws06-purchasing/queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";

// /kelola/pengadaan/faktur/baru — supplier invoice entry (PRD v1.7 §3.18,
// §4 Alur I step 4): copy the supplier's invoice, save once, read the match.
export const Route = createFileRoute("/_kelola/kelola/pengadaan_/faktur_/baru")(
  {
    beforeLoad: purchasingGuard(["purchasing.invoice.match"]),
    loader: ({ context, location }) =>
      isMockScenarioRequest(location.searchStr)
        ? undefined
        : Promise.all([
            // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
            context.queryClient.ensureQueryData(suppliersQuery()),
            context.queryClient.ensureQueryData(inventoryItemsQuery()),
            context.queryClient.ensureQueryData(uomsQuery()),
          ]),
    component: InvoiceFormScreen,
  },
);

function InvoiceFormScreen() {
  return (
    <PurchasingFrame active="invoices">
      <InvoiceFormPage />
    </PurchasingFrame>
  );
}
