import { createFileRoute } from "@tanstack/react-router";
import { CheckoutPage } from "@/features/ws03-qr-order/components/cart/checkout-page";

// "/t/[token]/checkout": server quote, serving estimate, pay-first or open bill
// (bead legend-8sh, ORD-02, ORD-03, ORD-05, ORD-11).
export const Route = createFileRoute("/_customer/t/$token/checkout")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: CheckoutPage,
});
