import { createFileRoute } from "@tanstack/react-router";
import { OrdersPage } from "@/features/ws03-qr-order/components/orders";

// "/t/[token]/orders": order status, waiter calls and bill request (bead
// legend-woz). Private, noindex via the customer area.
export const Route = createFileRoute("/_customer/t/$token/orders")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: OrdersPage,
});
