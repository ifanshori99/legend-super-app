import { createFileRoute } from "@tanstack/react-router";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { ReturnListPage } from "@/features/ws06-purchasing/components/return-page";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import {
  goodsReceiptsQuery,
  purchaseReturnsQuery,
} from "@/features/ws06-purchasing/receiving-queries";
import { suppliersQuery } from "@/features/ws06-purchasing/queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";

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
      : Promise.all([
          context.queryClient.ensureQueryData(
            purchaseReturnsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
          context.queryClient.ensureQueryData(
            goodsReceiptsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
          context.queryClient.ensureQueryData(suppliersQuery()),
        ]),
  component: ReturnListScreen,
});

function ReturnListScreen() {
  return (
    <PurchasingFrame active="returns">
      <ReturnListPage />
    </PurchasingFrame>
  );
}
