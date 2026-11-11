import { createFileRoute, notFound } from "@tanstack/react-router";
import { CashierMainScreen } from "@/features/ws04-pos-order/components/cashier/cashier-main-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/kasir — the cashier's main sale screen: pick menu, build the cart, send
// the order and continue to payment (PRD §3 F11 "POS Kasir"). Presentation
// guard only; the API re-checks `pos.sale.create` on every request.
export const Route = createFileRoute("/_ops/pos/kasir")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["pos.sale.create"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: CashierMainScreen,
});
