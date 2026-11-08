// "/t/[token]/cart" and "/checkout" are one page now: "Keranjang & bayar"
// (legend-2re1). The shared cart (PRD §3 F10 "Menu & Keranjang") and the
// payment step live in CheckoutPage; this keeps the cart route's component.
import { CheckoutPage } from "./checkout-page";

export function CartPage() {
  return <CheckoutPage />;
}
