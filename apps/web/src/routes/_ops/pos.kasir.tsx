import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { CashierMainScreen } from "@/features/ws04-pos-order/components/cashier/cashier-main-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /pos/kasir — the cashier's main sale screen: pick menu, build the cart, send
// the order and continue to payment (PRD §3 F11 "POS Kasir"). Presentation
// guard only; the API re-checks `pos.sale.create` on every request. On phones the
// cart is its own view: `?v=keranjang` keeps it in history, so the browser Back
// button returns to the menu.
export const Route = createFileRoute("/_ops/pos/kasir")({
  validateSearch: z.object({
    v: z.enum(["keranjang"]).optional().catch(undefined),
    // "Lanjutkan" on /pos/pesanan?tab=ditahan: open the parked carts sheet.
    ditahan: z.enum(["1"]).optional().catch(undefined),
    // "Lanjutkan di kasir" on an unsent order (draft): the cashier sends it.
    draft: z.string().min(1).max(80).optional().catch(undefined),
    // Mock seed (`?demo=offline`, `?demo=...`) read by the POS ordering mock;
    // kept so navigation does not drop it.
    demo: z.string().optional().catch(undefined),
  }),
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["pos.sale.create"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  component: CashierMainScreen,
});
