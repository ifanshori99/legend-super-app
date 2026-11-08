import { createFileRoute } from "@tanstack/react-router";
import { CashierPage } from "@/features/ws03-qr-order/components/cart/cashier-page";

// "/t/[token]/kasir/[orderId]": founder Q3 "Bayar di kasir" (legend-2re1).
// The pay-first order is placed and held; the guest shows its code at the
// cashier, the cashier takes the money, and only then does the order reach
// the kitchen. The page polls the session until the order leaves
// awaiting_payment; success comes from the server only.
export const Route = createFileRoute("/_customer/t/$token/kasir/$orderId")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: Cashier,
});

function Cashier() {
  const { orderId } = Route.useParams();
  return <CashierPage orderId={orderId} />;
}
