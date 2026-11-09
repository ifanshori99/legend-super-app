import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { OnlinePayPage } from "@/features/ws03-qr-order/components/cart/online-pay-page";

const searchSchema = z.object({
  metode: z.enum(["va"]).catch("va"),
});

// "/t/[token]/bayar/[orderId]": Virtual Account (legend-2re1, legend-3160).
// The order is placed and held for payment; the guest picks a bank from the
// payment options, the server opens the VA, and success comes from the
// gateway (the payment turning paid) only.
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
