import { createFileRoute } from "@tanstack/react-router";
import { PayPage } from "@/features/ws03-qr-order/components/cart/pay-page";

// "/t/[token]/pay/[paymentId]": QRIS step; polls until the gateway
// confirms (bead legend-8sh, ORD-02).
export const Route = createFileRoute("/_customer/t/$token/pay/$paymentId")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: Pay,
});

function Pay() {
  const { paymentId } = Route.useParams();
  return <PayPage paymentId={paymentId} />;
}
