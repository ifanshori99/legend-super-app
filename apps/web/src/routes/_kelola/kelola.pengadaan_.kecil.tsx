import { createFileRoute } from "@tanstack/react-router";
import { PettyPage } from "@/features/ws06-purchasing/components/petty-page";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import {
  pettyPurchasePolicyQuery,
  pettyPurchasesQuery,
} from "@/features/ws06-purchasing/receiving-queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/pengadaan/kecil — petty cash purchases with a mandatory photo and
// the per-transaction policy limit (PRD v1.7 §3.18 "Pembelian Sederhana").
export const Route = createFileRoute("/_kelola/kelola/pengadaan_/kecil")({
  beforeLoad: purchasingGuard([
    "accounting.expense.request",
    "accounting.supplier_payment.process",
  ]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            pettyPurchasesQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
          context.queryClient.ensureQueryData(
            pettyPurchasePolicyQuery({ outletId: INVENTORY_OUTLET_ID }),
          ),
        ]),
  component: PettyScreen,
});

function PettyScreen() {
  const { access } = Route.useRouteContext();
  return (
    <PurchasingFrame active="petty">
      <PettyPage canCreate={holdsAny(access, ["accounting.expense.request"])} />
    </PurchasingFrame>
  );
}
