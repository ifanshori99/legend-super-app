import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { OnlinePayPage } from "@/features/ws03-qr-order/components/cart/online-pay-page";

const searchSchema = z.object({
  metode: z.enum(["va"]).catch("va"),
});

// "/t/[token]/bayar/[orderId]": Virtual Account (legend-2re1). The
// table contract has no VA payment yet, so the checkout only opens
// this page in mock mode: the order is placed and held for payment, the page
// shows a demo VA number, and success comes from the
// server (the order leaving awaiting_payment) only.
export const Route = createFileRoute("/_customer/t/$token/bayar/$orderId")({
  validateSearch: searchSchema,
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: OnlinePay,
});

function OnlinePay() {
  const { orderId } = Route.useParams();
  const { metode } = Route.useSearch();
  return <OnlinePayPage orderId={orderId} method={metode} />;
}
