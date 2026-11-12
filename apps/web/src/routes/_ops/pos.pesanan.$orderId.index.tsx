import { createFileRoute } from "@tanstack/react-router";
import { OrderDetailScreen } from "@/features/ws04-pos-order-detail/components/order-detail-screen";
import { orderDetailGuard } from "@/features/ws04-pos-order-detail/guard";

// /pos/pesanan/$orderId — one order's lines and bill with the kitchen notices;
// "Ajukan void item" goes to /pos/pesanan/$orderId/koreksi?mode=void.
export const Route = createFileRoute("/_ops/pos/pesanan/$orderId/")({
  beforeLoad: orderDetailGuard(),
  component: OrderDetailRoute,
});

function OrderDetailRoute() {
  const { orderId } = Route.useParams();
  return <OrderDetailScreen orderId={orderId} />;
}
