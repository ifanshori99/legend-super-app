import { createFileRoute } from "@tanstack/react-router";
import { CashierCodeScreen } from "@/features/ws04-pos-kasir/components/cashier-code/cashier-code-screen";
import { cashierPaymentGuard } from "@/features/ws04-pos-kasir/guard";

// /pos/kode — find a "Bayar di kasir" order by its code and continue to payment.
export const Route = createFileRoute("/_ops/pos/kode")({
  beforeLoad: cashierPaymentGuard(),
  component: CashierCodeScreen,
});
