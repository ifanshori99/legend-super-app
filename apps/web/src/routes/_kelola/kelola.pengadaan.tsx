import { createFileRoute } from "@tanstack/react-router";
import { PurchasingPage } from "@/features/ws06-purchasing/components/purchasing-page";
import { PurchasingFrame } from "@/features/ws06-purchasing/components/purchasing-shell";
import { purchasingGuard } from "@/features/ws06-purchasing/guard";

export const Route = createFileRoute("/_kelola/kelola/pengadaan")({
  beforeLoad: purchasingGuard([
    "purchasing.request.create",
    "purchasing.order.create",
    "purchasing.order.approve",
  ]),
  component: PurchasingDocumentsScreen,
});

function PurchasingDocumentsScreen() {
  return (
    <PurchasingFrame active="documents">
      <PurchasingPage />
    </PurchasingFrame>
  );
}
