import { createFileRoute } from "@tanstack/react-router";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { ReceivingListPage } from "@/features/ws06-purchasing/components/receiving-list-page";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import { suppliersQuery } from "@/features/ws06-purchasing/queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";
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
      : // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
        context.queryClient.ensureQueryData(suppliersQuery()),
  component: ReceivingListScreen,
});

function ReceivingListScreen() {
  const { access } = Route.useRouteContext();
  return (
    <PurchasingFrame active="receiving">
      <ReceivingListPage
        canReceive={holdsAny(access, ["inventory.stock.receive"])}
        canJournalize={holdsAny(access, ["accounting.journal.post"])}
      />
    </PurchasingFrame>
  );
}
