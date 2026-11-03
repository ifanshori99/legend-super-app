import { createFileRoute } from "@tanstack/react-router";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { ReceivingListPage } from "@/features/ws06-purchasing/components/receiving-list-page";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import { goodsReceiptsQuery } from "@/features/ws06-purchasing/receiving-queries";
import {
  purchaseOrdersQuery,
  suppliersQuery,
} from "@/features/ws06-purchasing/queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
import { INVENTORY_OUTLET_ID } from "@/features/ws06-inventory/outlet";
import { holdsAny } from "@/lib/areas/guard";

// /kelola/pengadaan/penerimaan — goods receipt list (PRD v1.7 §3 F18, §16
// "penerimaan di ponsel", INV-05). This route file escapes the
// `kelola.pengadaan` route (which renders the request/PO screen) with the
// `_` suffix, the same convention as `kelola.pengadaan_.po.$id.cetak.tsx`.
export const Route = createFileRoute("/_kelola/kelola/pengadaan_/penerimaan/")({
  beforeLoad: purchasingGuard([
    "inventory.stock.receive",
    "purchasing.invoice.match",
  ]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(
            goodsReceiptsQuery({ outletId: INVENTORY_OUTLET_ID, limit: 100 }),
          ),
          context.queryClient.ensureQueryData(
            purchaseOrdersQuery(INVENTORY_OUTLET_ID),
          ),
          context.queryClient.ensureQueryData(suppliersQuery()),
        ]),
  component: ReceivingListScreen,
});

function ReceivingListScreen() {
  const { access } = Route.useRouteContext();
  return (
    <PurchasingFrame active="receiving">
      <ReceivingListPage
        canReceive={holdsAny(access, ["inventory.stock.receive"])}
      />
    </PurchasingFrame>
  );
}
