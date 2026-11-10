import { createFileRoute } from "@tanstack/react-router";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { ReturnListPage } from "@/features/ws06-purchasing/components/return-page";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import { suppliersQuery } from "@/features/ws06-purchasing/queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";

// /kelola/pengadaan/retur — purchase returns from goods receipts (PRD v1.7
// §3.18 "Retur Pembelian").
export const Route = createFileRoute("/_kelola/kelola/pengadaan_/retur")({
  beforeLoad: purchasingGuard([
    "inventory.stock.receive",
    "purchasing.invoice.match",
  ]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
        context.queryClient.ensureQueryData(suppliersQuery()),
  component: ReturnListScreen,
});

function ReturnListScreen() {
  return (
    <PurchasingFrame active="returns">
      <ReturnListPage />
    </PurchasingFrame>
  );
}
