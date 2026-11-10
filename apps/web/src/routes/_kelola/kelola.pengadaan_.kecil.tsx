import { createFileRoute } from "@tanstack/react-router";
import { PettyPage } from "@/features/ws06-purchasing/components/petty-page";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/pengadaan/kecil — petty cash purchases with a mandatory photo and
// the per-transaction policy limit (PRD v1.7 §3.18 "Pembelian Sederhana").
export const Route = createFileRoute("/_kelola/kelola/pengadaan_/kecil")({
  beforeLoad: purchasingGuard([
    "accounting.expense.request",
    "accounting.supplier_payment.process",
  ]),
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
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
