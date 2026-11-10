import { createFileRoute } from "@tanstack/react-router";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { ReceivingFormPage } from "@/features/ws06-purchasing/components/receiving-form-page";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";
import {
  inventoryItemsQuery,
  suppliersQuery,
  uomsQuery,
} from "@/features/ws06-purchasing/queries";
import { isMockScenarioRequest } from "@/features/ws06-inventory/lib";

// /kelola/pengadaan/penerimaan/baru — the phone-first receiving form (PRD §16
// "penerimaan di ponsel", INV-05).
export const Route = createFileRoute(
  "/_kelola/kelola/pengadaan_/penerimaan/baru",
)({
  beforeLoad: purchasingGuard(["inventory.stock.receive"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
          context.queryClient.ensureQueryData(suppliersQuery()),
          context.queryClient.ensureQueryData(inventoryItemsQuery()),
          context.queryClient.ensureQueryData(uomsQuery()),
        ]),
  component: ReceivingFormScreen,
});

function ReceivingFormScreen() {
  return (
    <PurchasingFrame active="receiving">
      <ReceivingFormPage />
    </PurchasingFrame>
  );
}
