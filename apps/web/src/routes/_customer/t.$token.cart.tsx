import { createFileRoute } from "@tanstack/react-router";
import { CartPage } from "@/features/ws03-qr-order/components/cart/cart-page";

// "/t/[token]/cart": the shared table cart (bead legend-8sh).
export const Route = createFileRoute("/_customer/t/$token/cart")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: CartPage,
});
