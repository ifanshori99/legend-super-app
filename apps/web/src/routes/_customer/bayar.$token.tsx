import { createFileRoute } from "@tanstack/react-router";
import { PaymentPage } from "@/features/ws05-payment/components/payment-page";

// "/bayar/[token]" — a customer payment link (PRD §3.13, D24; customer area
// per §5). The token is the guest credential and the API resolves the tenant
// from it (TEN-02: never from the client). A gateway redirect lands here with
// extra query params; none of them are read, so a redirect never settles the
// screen (PAY-02).
export const Route = createFileRoute("/_customer/bayar/$token")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: PaymentRoute,
});

function PaymentRoute() {
  const { token } = Route.useParams();
  return <PaymentPage token={token} />;
}
