import { createFileRoute } from "@tanstack/react-router";
import { PaymentScreen } from "@/features/ws04-pos-kasir/components/payment/payment-screen";
import { cashierPaymentGuard } from "@/features/ws04-pos-kasir/guard";

// /pos/bayar/$orderId — take payment for one bill: methods, split, cash,
// QRIS/VA/e-wallet/card and EDC (PRD §3 F11/F12). The `?demo=` seed is read by
// the mock module only, never here.
export const Route = createFileRoute("/_ops/pos/bayar/$orderId")({
  beforeLoad: cashierPaymentGuard(),
  component: PaymentRoute,
});

function PaymentRoute() {
  const { orderId } = Route.useParams();
  return <PaymentScreen orderId={orderId} />;
}
